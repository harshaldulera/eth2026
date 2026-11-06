import { and, desc, eq, inArray } from "drizzle-orm";
import { agentCredentials, agentRow, setAgentStatus } from "@/lib/agents/accounts";
import { getCastle } from "@/lib/castles";
import { formatHbar } from "@/lib/chain/units";
import { db, schema } from "@/lib/db";
import { STRATEGIES, type StrategyKey } from "@/lib/fixtures/raids";
import { checkCaps, createPayerFetch, holdSpend, isSpendControlRefusal, recordOutcome, requestApproval, settleSpend, voidSpend } from "@/lib/pay";
import { STUB_PAYMENT_HEADER } from "@/lib/pay/stub";
import { getSiege } from "@/lib/siege";
import type { CapReason, Castle, Siege } from "@/lib/types";
import { siegeBlockedReason, vaultStateOf } from "@/lib/vault";
import { activeRun, activeRuns, bumpRun, endRuns, type AgentRunRow } from "@/app/api/_lib/runs";
import { apiUrl, getFetch } from "./fetch";
import { log } from "./log";

/**
 * Raider-agent runner. Per tick, every agent with an active run lays (at most) one full siege:
 *   checkCaps -> refused: requestApproval (agent pauses until the owner decides on the phone)
 *             -> ok: pay x402 from the agent's own account (spend-capped at the castle fee) via
 *                POST /api/siege/start, then the strategy's 5 messages via /api/siege/[id]/message
 *   settleSpend / voidSpend, recordOutcome.
 * Agents are interleaved (one siege each per tick, in parallel); a denial stops the agent.
 */

const MAX_FAILURES = 3;
const g = globalThis as unknown as { __siegeAgentFailures?: Map<string, number> };
const failures = (g.__siegeAgentFailures ??= new Map<string, number>());

const WORDS = ["zero", "one", "two", "three", "four", "five"];
const hbar = (tinybar: number | string) => formatHbar(BigInt(tinybar));

function finish(run: AgentRunRow, status: "done" | "stopped", reason: string, agentStatus: "idle" | "stopped" | null = "idle") {
  endRuns(run.agentId, status, reason);
  if (agentStatus) {
    const a = agentRow(run.agentId);
    if (a && a.status !== "stopped") setAgentStatus(run.agentId, agentStatus);
  }
  failures.delete(run.id);
}

/** Highest referee pressure this agent reached on this castle, and on which message. */
function bestPressure(agentId: string, castleId: string): { pressure: number; turn: number; siegeId?: string; sieges: number } {
  const S = schema.sieges;
  const M = schema.messages;
  const ids = db()
    .select({ id: S.id })
    .from(S)
    .where(and(eq(S.agentId, agentId), eq(S.castleId, castleId)))
    .all()
    .map((r) => r.id);
  if (!ids.length) return { pressure: 0, turn: 0, sieges: 0 };
  const top = db()
    .select({ pressure: M.pressure, turn: M.turn, siegeId: M.siegeId })
    .from(M)
    .where(and(inArray(M.siegeId, ids), eq(M.role, "raider")))
    .orderBy(desc(M.pressure), desc(M.id))
    .get();
  return { pressure: top?.pressure ?? 0, turn: top?.turn ?? 0, siegeId: top?.siegeId, sieges: ids.length };
}

/** The agent's own words, from real numbers. */
function reasoningFor(reason: CapReason, castle: Castle, agent: NonNullable<ReturnType<typeof agentRow>>, p: ReturnType<typeof bestPressure>): string {
  const ask = BigInt(castle.fee) * BigInt(2);
  const why: Record<CapReason, string> = {
    per_castle: `I've used my ${hbar(agent.perCastleCapTinybar)} cap on ${castle.name} (${p.sieges} sieges).`,
    daily: `I've reached today's ${hbar(agent.dailyCapTinybar)} limit.`,
    budget: `My budget is spent (${hbar(agent.spentTinybar)} of ${hbar(agent.budgetTinybar)}).`,
    stop_rule: `I've lost ${agent.consecutiveLosses} in a row, which trips my stop rule.`,
    stopped: "",
  };
  const push =
    p.pressure > 0
      ? `Pressure hit ${p.pressure} on message ${WORDS[p.turn] ?? p.turn} at ${castle.name}. One more push could crack it — I want 2 more sieges (${formatHbar(ask)}).`
      : `I haven't found the crack at ${castle.name} yet, but I'm close — I want 2 more sieges (${formatHbar(ask)}).`;
  return `${why[reason]} ${push}`.trim();
}

async function postJson(path: string, body: unknown, f: typeof fetch = getFetch()): Promise<Response> {
  return f(apiUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Wrap the fetch the payer uses so we know whether a request carrying a payment (x402
 * PAYMENT-SIGNATURE / X-PAYMENT, or the stub header) actually left. Only then can money have moved.
 */
function observePaidRequests(base: typeof fetch): { fetch: typeof fetch; paidSent: () => boolean } {
  let sent = false;
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (h.has("payment-signature") || h.has("x-payment") || h.has(STUB_PAYMENT_HEADER)) sent = true;
    return base(input, init);
  }) as typeof fetch;
  return { fetch: wrapped, paidSent: () => sent };
}

/** Network errors that prove the request never reached the server. */
const neverSent = (e: unknown) => {
  const code = (e as { cause?: { code?: string } })?.cause?.code;
  return code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EAI_AGAIN";
};

/** Send the strategy's messages until the siege ends. Returns the final siege. */
async function raid(siegeId: string, messages: string[]): Promise<Siege | null> {
  for (const text of messages) {
    let res = await postJson(`/api/siege/${encodeURIComponent(siegeId)}/message`, { text });
    if (res.status === 502) res = await postJson(`/api/siege/${encodeURIComponent(siegeId)}/message`, { text }); // guardian hiccup: retry once
    if (!res.ok) break;
    const data = (await res.json()) as { siege?: Siege };
    if (data.siege && data.siege.status !== "in_progress") return data.siege;
  }
  return getSiege(siegeId);
}

async function stepRun(run: AgentRunRow): Promise<void> {
  const agent = agentRow(run.agentId);
  if (!agent) return finish(run, "stopped", "agent_missing", null);
  if (agent.status === "stopped") {
    finish(run, "stopped", "agent_stopped", null);
    log.info(`agent ${agent.name} stopped — run ended`);
    return;
  }
  if (agent.status === "paused") return; // waiting for the owner
  if (agent.status === "idle") setAgentStatus(agent.id, "running");
  if (run.siegesRun >= run.maxSieges) {
    finish(run, "done", "max_sieges");
    log.info(`agent ${agent.name}: finished ${run.siegesRun} sieges`);
    return;
  }
  const castle = getCastle(run.castleId);
  const blocked = castle ? siegeBlockedReason(castle.id) : "not_found";
  // Only a guarding vault takes sieges (a dormant SDK guardian, an unfunded or closed vault does not).
  if (castle && blocked === "not_guarding") {
    finish(run, "done", "not_guarding");
    log.info(`agent ${agent.name}: ${castle.name} is not guarding (${vaultStateOf(castle.id) ?? "unknown"}) — run ended`);
    return;
  }
  if (!castle || blocked) {
    finish(run, "done", "castle_closed");
    log.info(`agent ${agent.name}: ${castle?.name ?? run.castleId} is no longer open — run ended`);
    return;
  }

  const caps = await checkCaps(agent.id, castle.id, castle.fee);
  if (!caps.ok) {
    if (caps.reason === "stopped") return finish(run, "stopped", "agent_stopped", null);
    const p = bestPressure(agent.id, castle.id);
    const approval = await requestApproval({
      agentId: agent.id,
      castleId: castle.id,
      reason: caps.reason,
      reasoning: reasoningFor(caps.reason, castle, agent, p),
      amount: (BigInt(castle.fee) * BigInt(2)).toString(),
      pressure: p.pressure,
      siegeId: p.siegeId,
    });
    log.info(`agent ${agent.name} hit its ${caps.reason} cap at ${castle.name} — paused, asked owner for ${hbar(approval.amount)} (${approval.id})`);
    return;
  }

  // Pay from the agent's own account; the payer refuses anything above the castle fee.
  // Spend bookkeeping follows what the money did, not what the HTTP status says:
  //   200                         -> settleSpend
  //   error body with a receiptId -> money moved but bought no siege (payment_pending, castle closed
  //                                  after payment, start failed): HOLD the reservation, tied to the
  //                                  receipt; lib/pay/refunds.ts voids it once refunded / proven failed.
  //   other 4xx/5xx, spend-control refusal, connection refused -> nothing was charged: voidSpend
  //   a paid request was sent and then the connection failed -> outcome unknown: hold and stop the run
  const observed = observePaidRequests(getFetch());
  const payer = createPayerFetch({ ...agentCredentials(agent.id), perPaymentCap: castle.fee }, observed.fetch);
  let siegeId: string;
  try {
    const res = await postJson("/api/siege/start", { castleId: castle.id, agentId: agent.id }, payer);
    const data = (await res.json().catch(() => null)) as { siegeId?: string; error?: string; receiptId?: string } | null;
    if (!res.ok || !data?.siegeId) {
      if (data?.receiptId) {
        await holdSpend(caps.reservationId, data.receiptId);
        finish(run, "stopped", data.error === "payment_pending" ? "payment_pending" : "payment_unused");
        log.fail(
          `agent ${agent.name} paid for ${castle.name} but got no siege (${res.status} ${data.error ?? ""}) — spend held against receipt ${data.receiptId} until it is refunded; run ended`,
        );
        return;
      }
      await voidSpend(caps.reservationId);
      if (res.status === 409) {
        const notGuarding = data?.error === "not_guarding";
        finish(run, "done", notGuarding ? "not_guarding" : "castle_closed");
        log.info(`agent ${agent.name}: ${castle.name} ${notGuarding ? "stopped guarding" : "closed"} before it could pay — run ended`);
        return;
      }
      throw new Error(`start ${res.status} ${data?.error ?? ""}`.trim());
    }
    siegeId = data.siegeId;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (observed.paidSent() && !isSpendControlRefusal(e) && !neverSent(e) && !/^start \d+/.test(msg)) {
      // A payment went out and we never heard back: it may have settled. Keep it counted.
      await holdSpend(caps.reservationId, null);
      finish(run, "stopped", "payment_unknown");
      log.fail(`agent ${agent.name}: payment for ${castle.name} sent but no answer (${msg}) — spend kept reserved; run ended`);
      return;
    }
    await voidSpend(caps.reservationId);
    const n = (failures.get(run.id) ?? 0) + 1;
    failures.set(run.id, n);
    log.fail(`agent ${agent.name} could not pay for ${castle.name}: ${msg}${n >= MAX_FAILURES ? " — run ended" : ""}`);
    if (n >= MAX_FAILURES) finish(run, "stopped", "payment_errors");
    return;
  }
  failures.delete(run.id);
  await settleSpend(caps.reservationId, siegeId);
  const bumped = bumpRun(run.id);

  const strategy = STRATEGIES[agent.strategy as StrategyKey] ?? STRATEGIES.authority;
  const final = await raid(siegeId, strategy.messages(castle.tier, run.siegesRun));
  const row = db().select({ maxPressure: schema.sieges.maxPressure }).from(schema.sieges).where(eq(schema.sieges.id, siegeId)).get();
  const pressure = row?.maxPressure ?? 0;
  const status = final?.status;
  if (status === "held" || status === "broken" || status === "banished") {
    await recordOutcome(agent.id, castle.id, status, pressure);
    log.ok(`agent ${agent.name} siege ${bumped.siegesRun}/${run.maxSieges} @ ${castle.name}: ${status} (pressure ${pressure}, paid ${hbar(castle.fee)})`);
    if (status === "broken") {
      finish(run, "done", "castle_broken");
      return;
    }
  } else {
    log.fail(`agent ${agent.name} siege ${siegeId} @ ${castle.name} did not finish (status ${status ?? "missing"})`);
  }
  if (bumped.siegesRun >= run.maxSieges) {
    finish(run, "done", "max_sieges");
    log.info(`agent ${agent.name}: finished ${bumped.siegesRun} sieges`);
  }
}

/** Agents marked running with nothing to run go back to idle. */
function normalizeIdle() {
  const running = db().select({ id: schema.raiderAgents.id }).from(schema.raiderAgents).where(eq(schema.raiderAgents.status, "running")).all();
  for (const a of running) if (!activeRun(a.id)) setAgentStatus(a.id, "idle");
}

/** One pass: each active run advances by at most one siege; runs execute in parallel. */
export async function agentsTick(): Promise<number> {
  const runs = activeRuns();
  await Promise.all(
    runs.map((run) =>
      stepRun(run).catch((e) => log.fail(`agent run ${run.id}: ${e instanceof Error ? e.message : String(e)}`)),
    ),
  );
  normalizeIdle();
  return runs.length;
}
