import { and, desc, eq, max, sql } from "drizzle-orm";
import type { Amount, ApprovalRequest, ApprovalStatus, CapReason, SiegeEvent, TxRef } from "@/lib/types";
import { db, schema } from "@/lib/db";
import { emit } from "@/lib/events/bus";
import { newId, nowIso } from "@/lib/util/ids";
import { isStubRef, txUrl } from "@/lib/chain/hashscan";
import { agentRow, setAgentStatus, topUpAgent } from "@/lib/agents/accounts";

/**
 * Owner approvals for raider agents. When an agent hits a cap it asks (requestApproval: the agent
 * pauses), the owner approves from the phone (on-chain top-up, agent resumes) or denies (agent stops).
 */

const ap = schema.approvalRequests;
const ag = schema.raiderAgents;
const ca = schema.castles;

const selection = {
  a: ap,
  agentName: ag.name,
  castleName: ca.name,
};

function baseQuery() {
  return db().select(selection).from(ap).leftJoin(ag, eq(ag.id, ap.agentId)).leftJoin(ca, eq(ca.id, ap.castleId));
}

type Joined = { a: typeof ap.$inferSelect; agentName: string | null; castleName: string | null };

function txRef(txId: string): TxRef {
  return { txId, hashscanUrl: txUrl(txId), ...(isStubRef(txId) ? { stub: true } : {}) };
}

function toApproval({ a, agentName, castleName }: Joined): ApprovalRequest {
  return {
    id: a.id,
    agentId: a.agentId,
    agentName: agentName ?? a.agentId,
    castleId: a.castleId,
    castleName: castleName ?? a.castleId,
    ...(a.siegeId ? { siegeId: a.siegeId } : {}),
    reason: a.reason as CapReason,
    reasoning: a.reasoning,
    amount: String(a.amountTinybar),
    pressure: a.pressure,
    status: a.status,
    createdAt: a.createdAt,
    ...(a.resolvedAt ? { resolvedAt: a.resolvedAt } : {}),
    ...(a.topUpTx ? { topUp: txRef(a.topUpTx) } : {}),
  };
}

function loadApproval(id: string): ApprovalRequest | null {
  const r = baseQuery().where(eq(ap.id, id)).get();
  return r ? toApproval(r) : null;
}

/** Fire-and-forget HCS audit (never blocks the approval). */
function audit(a: ApprovalRequest, kind: "requested" | "approved" | "denied") {
  const event: SiegeEvent = {
    siegeId: "",
    castleId: a.castleId,
    type: "approval",
    payload: { kind, approvalId: a.id, agentId: a.agentId, reason: a.reason, amount: a.amount, ...(a.topUp ? { txId: a.topUp.txId } : {}) },
    at: nowIso(),
  };
  void import("@/lib/chain")
    .then(({ chain }) => chain.audit(event))
    .catch((e) => console.warn("[approvals] audit failed:", e instanceof Error ? e.message : e));
}

function emitApproval(a: ApprovalRequest, kind: "requested" | "approved" | "denied", extra: Record<string, unknown> = {}) {
  emit({
    siegeId: a.siegeId ?? "",
    castleId: a.castleId,
    type: "approval",
    payload: {
      kind,
      approvalId: a.id,
      agentId: a.agentId,
      agentName: a.agentName,
      castleId: a.castleId,
      castleName: a.castleName,
      amount: a.amount,
      reason: a.reason,
      pressure: a.pressure,
      ...extra,
    },
  });
}

/** Highest referee pressure this agent reached on this castle (from its sieges). */
function maxPressure(agentId: string, castleId: string): number {
  const s = schema.sieges;
  return (
    db()
      .select({ v: max(s.maxPressure) })
      .from(s)
      .where(and(eq(s.agentId, agentId), eq(s.castleId, castleId)))
      .get()?.v ?? 0
  );
}

/**
 * Ask the owner for more allowance. Idempotent per (agent, castle) while a request is pending:
 * a second call returns the pending one (pressure raised to the max seen). Pauses the agent.
 */
export async function requestApproval(i: {
  agentId: string;
  castleId: string;
  reason: CapReason;
  reasoning: string;
  amount: Amount;
  pressure: number;
  siegeId?: string;
}): Promise<ApprovalRequest> {
  if (!agentRow(i.agentId)) throw new Error(`agent ${i.agentId} not found`);
  const pressure = Math.max(0, Math.min(100, Math.round(Math.max(i.pressure, maxPressure(i.agentId, i.castleId)))));

  const { id, created } = db().transaction((tx) => {
    const existing = tx
      .select()
      .from(ap)
      .where(and(eq(ap.agentId, i.agentId), eq(ap.castleId, i.castleId), eq(ap.status, "pending")))
      .get();
    if (existing) {
      if (pressure > existing.pressure) tx.update(ap).set({ pressure }).where(eq(ap.id, existing.id)).run();
      return { id: existing.id, created: false };
    }
    const id = newId("appr");
    tx.insert(ap)
      .values({
        id,
        agentId: i.agentId,
        castleId: i.castleId,
        siegeId: i.siegeId ?? null,
        reason: i.reason,
        reasoning: i.reasoning.slice(0, 1000),
        amountTinybar: Number(i.amount),
        pressure,
        status: "pending",
        createdAt: nowIso(),
      })
      .run();
    tx.update(ag).set({ status: "paused" }).where(and(eq(ag.id, i.agentId), sql`${ag.status} != 'stopped'`)).run();
    return { id, created: true };
  });

  const approval = loadApproval(id)!;
  if (created) {
    emitApproval(approval, "requested");
    audit(approval, "requested");
  }
  return approval;
}

/** The owner's call. Approve = on-chain top-up + agent resumes; deny = agent stops. */
export async function decideApproval(
  id: string,
  decision: "approved" | "denied",
): Promise<{ ok: true; approval: ApprovalRequest } | { ok: false; reason: "not_found" | "already_decided" }> {
  // Claim the decision atomically so two taps (or two owners) cannot both act.
  // An agent its owner already stopped is never topped up or restarted by a late approve: its request
  // is closed as denied instead (re-running a stopped agent is an explicit owner action, POST /run).
  const claim = db().transaction((tx) => {
    const row = tx.select().from(ap).where(eq(ap.id, id)).get();
    if (!row) return { ok: false as const, reason: "not_found" as const };
    if (row.status !== "pending") return { ok: false as const, reason: "already_decided" as const };
    const agent = tx.select({ status: ag.status }).from(ag).where(eq(ag.id, row.agentId)).get();
    if (decision === "approved" && (!agent || agent.status === "stopped")) {
      tx.update(ap).set({ status: "denied", resolvedAt: nowIso() }).where(eq(ap.id, id)).run();
      return { ok: false as const, reason: "already_decided" as const, stopped: true };
    }
    tx.update(ap).set({ status: decision, resolvedAt: nowIso() }).where(eq(ap.id, id)).run();
    return { ok: true as const, row };
  });
  if (!claim.ok) {
    if ("stopped" in claim) {
      const closed = loadApproval(id);
      if (closed) {
        emitApproval(closed, "denied", { auto: "agent_stopped" });
        audit(closed, "denied");
      }
    }
    return { ok: false, reason: claim.reason };
  }
  const row = claim.row;

  if (decision === "approved") {
    let topUp: TxRef;
    try {
      topUp = await topUpAgent(row.agentId, String(row.amountTinybar));
    } catch (e) {
      // Money did not move: put the request back so the owner can retry.
      db().update(ap).set({ status: "pending", resolvedAt: null }).where(eq(ap.id, id)).run();
      throw e;
    }
    db().update(ap).set({ topUpTx: topUp.txId }).where(eq(ap.id, id)).run();
    if (row.reason === "stop_rule") db().update(ag).set({ consecutiveLosses: 0 }).where(eq(ag.id, row.agentId)).run();
    // Resume — unless the owner stopped it while the top-up was in flight.
    db().update(ag).set({ status: "running" }).where(and(eq(ag.id, row.agentId), sql`${ag.status} != 'stopped'`)).run();
  } else {
    setAgentStatus(row.agentId, "stopped");
  }

  const approval = loadApproval(id)!;
  emitApproval(approval, decision, approval.topUp ? { topUp: approval.topUp } : {});
  audit(approval, decision);
  return { ok: true, approval };
}

/** Close every pending request of an agent as denied (the owner stopped it). Returns how many. */
export function cancelPendingApprovals(agentId: string, why = "agent stopped"): number {
  const rows = db().select({ id: ap.id }).from(ap).where(and(eq(ap.agentId, agentId), eq(ap.status, "pending"))).all();
  let n = 0;
  for (const r of rows) {
    const res = db().update(ap).set({ status: "denied", resolvedAt: nowIso() }).where(and(eq(ap.id, r.id), eq(ap.status, "pending"))).run();
    if (res.changes !== 1) continue;
    n++;
    const a = loadApproval(r.id);
    if (a) {
      emitApproval(a, "denied", { auto: why });
      audit(a, "denied");
    }
  }
  return n;
}

export async function listApprovals(status: ApprovalStatus | "all" = "all"): Promise<ApprovalRequest[]> {
  const q = baseQuery();
  const rows = (status === "all" ? q : q.where(eq(ap.status, status))).orderBy(desc(ap.createdAt)).all();
  return rows.map(toApproval);
}

export async function getApproval(id: string): Promise<ApprovalRequest | null> {
  return loadApproval(id);
}

/** Approvals for one agent (agent detail page). */
export function approvalsForAgent(agentId: string): ApprovalRequest[] {
  return baseQuery().where(eq(ap.agentId, agentId)).orderBy(desc(ap.createdAt)).all().map(toApproval);
}
