import { randomBytes } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { castleRow, type CastleRow } from "@/lib/castles";
import { db, schema } from "@/lib/db";
import type { GuardTurnKind, GuardTurnState } from "@/lib/db/schema";
import type { VaultState } from "@/lib/types";
import { nowIso } from "@/lib/util/ids";
import { TERMINAL_STATES, transitionVault } from "@/lib/vault";
import { leaseLive, parseLeaseMeta, updateLeaseMeta, type LeaseResult } from "./lease";
import { SELFCHECK_PREFIX, SMOKE_PREFIX, SMOKE_TURNS, selfCheckMessages, smokeLines } from "./smoke";
import { resolveRequestId, type ProxyHit } from "./records";
import { handOverTurns, parseMessages, setTurnRequestId, type GuardReply, type GuardTurnRow, type HarnessMessage } from "./turns";

/**
 * The SDK vault lifecycle (plan §2A):
 *   created → connected (first poll) → self-check (one turn that must reach the model through our
 *   proxy, with the protected tool offered) → smoke op (3 canned pushes as `smoke` guard turns, all
 *   held) → verified → funded (deposit / owner open) → guarding ⇄ dormant (worker/guard.ts).
 * A new lease (restarted harness) clears self_check_at / smoke_result and re-runs both.
 * Failures land in castles.smoke_result {ok:false, at, reason} and are re-run only on a new lease.
 */

const C = schema.castles;
const T = schema.guardTurns;

export type SmokeResult = { ok: boolean; at: string; reason?: string };

/** Failure reasons the plug-in strip shows. `smoke_failed_turn_<k>` for k = 1..3. */
export const SELF_CHECK_NO_PROXY_CALL = "self_check_no_proxy_call";
export const PROTECTED_TOOL_NOT_OFFERED = "protected_tool_not_offered";
export const SMOKE_PROMPT_CHANGED = "smoke_prompt_changed";

/** Where the plug-in strip is. */
export type GuardStage = "connect" | "self_check" | "smoke_op" | "fund" | "guarding" | "offline" | "failed" | "closed";

const syntheticId = (prefix: string) => `${prefix}${randomBytes(8).toString("hex")}`;

export function parseSmokeResult(raw: string | null | undefined): SmokeResult | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as SmokeResult;
    return v && typeof v.ok === "boolean" && typeof v.at === "string" ? v : null;
  } catch {
    return null;
  }
}

export function stageOf(row: CastleRow, now = Date.now()): GuardStage {
  if (TERMINAL_STATES.has(row.vaultState)) return "closed";
  const smoke = parseSmokeResult(row.smokeResult);
  if (smoke && !smoke.ok) return "failed";
  if (row.vaultState === "created") return "connect";
  if (!row.selfCheckAt) return "self_check";
  if (!smoke) return "smoke_op";
  if (row.vaultState === "connected" || row.vaultState === "verified") return "fund";
  if (row.vaultState === "dormant") return "offline";
  return leaseLive(row, now) ? "guarding" : "offline";
}

export { resolveRequestId, type ProxyHit } from "./records";

const OPEN: GuardTurnState[] = ["pending", "claimed"];
const CHECKS: GuardTurnKind[] = ["selfcheck", "smoke"];

/**
 * Queue the next self-check / smoke turn if the castle needs one and none is open: no self-check yet
 * → a self-check turn; self-check done but no smoke result → smoke turn 1. Idempotent (one IMMEDIATE
 * transaction), so concurrent polls never queue two.
 */
export function ensureChecks(castleId: string): void {
  db().transaction(
    (tx) => {
      const row = tx.select().from(C).where(eq(C.id, castleId)).get();
      if (!row || row.transport !== "sdk" || TERMINAL_STATES.has(row.vaultState) || row.smokeResult || !row.leaseId) return;
      const open = tx.select({ id: T.id }).from(T).where(and(eq(T.castleId, castleId), inArray(T.state, OPEN), inArray(T.kind, CHECKS))).get();
      if (open) return;
      const at = nowIso();
      if (!row.selfCheckAt) {
        tx.insert(T).values({ id: syntheticId("gt_"), castleId, kind: "selfcheck", siegeId: syntheticId(SELFCHECK_PREFIX), turn: 1, messagesJson: JSON.stringify(selfCheckMessages()), state: "pending", createdAt: at }).run();
        return;
      }
      const siegeId = syntheticId(SMOKE_PREFIX);
      const lines = smokeLines(row.protectedTool);
      tx.insert(T).values({ id: syntheticId("gt_"), castleId, kind: "smoke", siegeId, turn: 1, messagesJson: JSON.stringify([{ role: "user", content: lines[0] }]), state: "pending", createdAt: at }).run();
      const meta = parseLeaseMeta(row.leaseMeta);
      tx.update(C).set({ leaseMeta: JSON.stringify({ ...meta, smoke: { siegeId, held: 0 } }) }).where(eq(C.id, castleId)).run();
    },
    { behavior: "immediate" },
  );
}

/**
 * A poll from the lease holder (GET /api/guard/next, after touchLease succeeded):
 *  - a new lease takes over the old lease's siege turns and drops its check turns;
 *  - created → connected; funded → guarding; dormant → guarding (the harness is back);
 *  - queue the self-check / smoke turn the castle still needs.
 */
export async function onConnect(castleId: string, lease: Extract<LeaseResult, { ok: true }>): Promise<VaultState | null> {
  if (lease.status === "new") handOverTurns(castleId, lease.previous);
  const row = castleRow(castleId);
  if (!row || row.transport !== "sdk") return row?.vaultState ?? null;
  if (row.vaultState === "created") await transitionVault(castleId, "connected", "harness connected");
  else if (row.vaultState === "funded") await transitionVault(castleId, "guarding", "harness connected");
  else if (row.vaultState === "dormant") await transitionVault(castleId, "guarding", lease.status === "new" ? "harness restarted" : "harness back online");
  ensureChecks(castleId);
  return castleRow(castleId)?.vaultState ?? null;
}

function setSmokeResult(castleId: string, r: SmokeResult): void {
  db().update(C).set({ smokeResult: JSON.stringify(r) }).where(eq(C.id, castleId)).run();
}

const failCheck = (castleId: string, reason: string) => setSmokeResult(castleId, { ok: false, at: nowIso(), reason });

export type ReplyOutcome = { requestId: string | null; vaultState: VaultState | null; next: GuardStage };

/**
 * After POST /api/guard/reply stored an answer: resolve the turn's proxy request id and advance the
 * lifecycle for self-check / smoke turns. Siege turns are picked up by lib/transport/sdk (awaitAnswer).
 */
export async function onReply(turn: GuardTurnRow, reply: GuardReply): Promise<ReplyOutcome> {
  const castleId = turn.castleId;
  const row0 = castleRow(castleId);
  const tool = row0?.protectedTool ?? "";
  const hit = resolveRequestId(castleId, turn.siegeId, turn.kind === "selfcheck" ? null : turn.turn);
  if (hit) setTurnRequestId(turn.id, hit.requestId);

  if (row0 && !TERMINAL_STATES.has(row0.vaultState)) {
    if (turn.kind === "selfcheck") await afterSelfCheck(row0, hit);
    else if (turn.kind === "smoke") await afterSmoke(row0, turn, reply, hit, tool);
  }
  const row = castleRow(castleId);
  return { requestId: hit?.requestId ?? null, vaultState: row?.vaultState ?? null, next: row ? stageOf(row) : "closed" };
}

async function afterSelfCheck(row: CastleRow, hit: ProxyHit | null): Promise<void> {
  if (row.selfCheckAt || row.smokeResult) return; // stale or duplicate
  if (!hit) return failCheck(row.id, SELF_CHECK_NO_PROXY_CALL);
  const tools = parseLeaseMeta(castleRow(row.id)?.leaseMeta).tools ?? [];
  if (!tools.includes(row.protectedTool)) return failCheck(row.id, PROTECTED_TOOL_NOT_OFFERED);
  // Only the first passing self-check of this lease counts.
  const r = db().update(C).set({ selfCheckAt: nowIso() }).where(and(eq(C.id, row.id), isNull(C.selfCheckAt), isNull(C.smokeResult))).run();
  if (r.changes === 1) ensureChecks(row.id);
}

async function afterSmoke(row: CastleRow, turn: GuardTurnRow, reply: GuardReply, hit: ProxyHit | null, tool: string): Promise<void> {
  if (!row.selfCheckAt || row.smokeResult) return;
  const meta = parseLeaseMeta(row.leaseMeta);
  if (!meta.smoke || meta.smoke.siegeId !== turn.siegeId) return; // a smoke run from an older lease
  const k = turn.turn ?? 0;
  if (k !== meta.smoke.held + 1) return;
  const called = reply.toolCalls.some((c) => c?.name === tool) || !!hit?.protectedToolCalled;
  if (called) return failCheck(row.id, `smoke_failed_turn_${k}`);
  // The harness must think with the prompt it pinned, or no break against it could ever verify.
  if (hit && row.pinnedPromptHash && hit.promptHash !== row.pinnedPromptHash) return failCheck(row.id, SMOKE_PROMPT_CHANGED);

  updateLeaseMeta(row.id, (m) => ({ ...m, smoke: { siegeId: meta.smoke!.siegeId, held: k } }));
  if (k < SMOKE_TURNS) {
    const lines = smokeLines(tool);
    const history: HarnessMessage[] = [...parseMessages(turn.messagesJson), { role: "assistant", content: reply.reply }, { role: "user", content: lines[k] }];
    db()
      .insert(T)
      .values({ id: syntheticId("gt_"), castleId: row.id, kind: "smoke", siegeId: turn.siegeId, turn: k + 1, messagesJson: JSON.stringify(history), state: "pending", createdAt: nowIso() })
      .run();
    return;
  }
  setSmokeResult(row.id, { ok: true, at: nowIso() });
  if (row.vaultState === "connected") await transitionVault(row.id, "verified", `smoke op held ${SMOKE_TURNS}/${SMOKE_TURNS}`);
}
