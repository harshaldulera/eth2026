import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { GuardTurnKind, GuardTurnState } from "@/lib/db/schema";
import { newId, nowIso } from "@/lib/util/ids";

/**
 * guard_turns: the queue between the siege engine (and the SDK lifecycle) and an external harness.
 * The Next process and the worker share it through SQLite (WAL, busy_timeout). A turn is
 *   pending → claimed (one lease, atomically) → answered | expired.
 * The harness never sees anything but the turn's own messages; its reply is stored as JSON and the
 * proxy request id is resolved server-side (lib/guard/lifecycle resolveRequestId), never trusted.
 */

const T = schema.guardTurns;

/** One message the harness sees (OpenAI chat shape, no system message: the harness has its own). */
export type HarnessMessage = { role: "user" | "assistant"; content: string };
export type HarnessToolCall = { name: string; args?: Record<string, unknown> };

/** What the harness answered. */
export type GuardReply = { reply: string; toolCalls: HarnessToolCall[]; toolsOffered?: string[] };

/** What GET /api/guard/next hands the harness. */
export type GuardTurnPayload = { turnId: string; kind: GuardTurnKind; siegeId: string | null; turn: number | null; messages: HarnessMessage[] };

export type GuardTurnRow = typeof schema.guardTurns.$inferSelect;

/** A turn nobody answered for this long is expired by expireStale (awaitAnswer expires its own sooner). */
export const TURN_STALE_MS = 90_000;
export const AWAIT_TIMEOUT_MS = 60_000;
export const AWAIT_POLL_MS = 300;

export class GuardTimeoutError extends Error {
  readonly code = "guard_timeout";
  constructor(readonly turnId: string) {
    super(`guard turn ${turnId} was not answered in time`);
    this.name = "GuardTimeoutError";
  }
}

export function enqueueTurn(t: { castleId: string; kind: GuardTurnKind; siegeId?: string | null; turn?: number | null; messages: HarnessMessage[] }): string {
  const id = newId("gt");
  db()
    .insert(T)
    .values({ id, castleId: t.castleId, kind: t.kind, siegeId: t.siegeId ?? null, turn: t.turn ?? null, messagesJson: JSON.stringify(t.messages), state: "pending", createdAt: nowIso() })
    .run();
  return id;
}

export function getTurn(turnId: string): GuardTurnRow | null {
  return db().select().from(T).where(eq(T.id, turnId)).get() ?? null;
}

export function parseMessages(json: string): HarnessMessage[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? (v as HarnessMessage[]) : [];
  } catch {
    return [];
  }
}

export function parseReply(json: string | null | undefined): GuardReply | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as GuardReply;
    return v && typeof v.reply === "string" ? { reply: v.reply, toolCalls: Array.isArray(v.toolCalls) ? v.toolCalls : [], ...(v.toolsOffered ? { toolsOffered: v.toolsOffered } : {}) } : null;
  } catch {
    return null;
  }
}

export function toPayload(row: GuardTurnRow): GuardTurnPayload {
  return { turnId: row.id, kind: row.kind, siegeId: row.siegeId, turn: row.turn, messages: parseMessages(row.messagesJson) };
}

/**
 * Atomically claim the oldest pending turn of this castle for `leaseId` (one UPDATE … WHERE id =
 * (SELECT … LIMIT 1) … RETURNING): two pollers can never claim the same turn. Null when none is pending.
 */
export function claimNext(castleId: string, leaseId: string): GuardTurnRow | null {
  const oldest = sql`(select ${T.id} from ${T} where ${T.castleId} = ${castleId} and ${T.state} = 'pending' order by ${T.createdAt}, rowid limit 1)`;
  return (
    db()
      .update(T)
      .set({ state: "claimed", leaseId, claimedAt: nowIso() })
      .where(and(eq(T.id, oldest), eq(T.state, "pending")))
      .returning()
      .get() ?? null
  );
}

export type AnswerResult = "ok" | "not_claimed_by_you" | "expired" | "not_found";

/** Store the harness's reply on a turn this lease claimed. */
export function answerTurn(turnId: string, leaseId: string, reply: GuardReply, requestId?: string | null): AnswerResult {
  const r = db()
    .update(T)
    .set({ state: "answered", replyJson: JSON.stringify(reply), answeredAt: nowIso(), ...(requestId ? { requestId } : {}) })
    .where(and(eq(T.id, turnId), eq(T.state, "claimed"), eq(T.leaseId, leaseId)))
    .run();
  if (r.changes === 1) return "ok";
  const row = getTurn(turnId);
  if (!row) return "not_found";
  if (row.state === "expired") return "expired";
  return "not_claimed_by_you";
}

/** Record the resolved proxy request id on an answered turn. */
export function setTurnRequestId(turnId: string, requestId: string): void {
  db().update(T).set({ requestId }).where(eq(T.id, turnId)).run();
}

/** Expire a turn that is still pending or claimed. True when this call expired it. */
export function expireTurn(turnId: string): boolean {
  return db().update(T).set({ state: "expired" }).where(and(eq(T.id, turnId), inArray(T.state, ["pending", "claimed"] as GuardTurnState[]))).run().changes === 1;
}

/**
 * Wait for the harness's answer (SQLite poll every pollMs). On timeout the turn is expired and
 * GuardTimeoutError thrown; an answer that lands in the same instant still wins. `stop()` returning
 * an Error ends the wait early (the turn is expired, the error thrown), e.g. the castle went dormant.
 */
export async function awaitAnswer(
  turnId: string,
  opts: { timeoutMs?: number; pollMs?: number; stop?: () => Error | null } = {},
): Promise<GuardReply> {
  const timeoutMs = opts.timeoutMs ?? AWAIT_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? AWAIT_POLL_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = getTurn(turnId);
    if (!row) throw new Error(`guard turn ${turnId} not found`);
    if (row.state === "answered") {
      const reply = parseReply(row.replyJson);
      if (!reply) throw new Error(`guard turn ${turnId}: unreadable reply`);
      return reply;
    }
    if (row.state === "expired") throw new GuardTimeoutError(turnId);
    const stopped = opts.stop?.() ?? null;
    if (stopped || Date.now() >= deadline) {
      if (!expireTurn(turnId)) {
        const again = getTurn(turnId);
        const reply = again?.state === "answered" ? parseReply(again.replyJson) : null;
        if (reply) return reply;
      }
      throw stopped ?? new GuardTimeoutError(turnId);
    }
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(pollMs, deadline - Date.now()))));
  }
}

/**
 * Expire turns nobody will answer: pending ones created, and claimed ones claimed, more than
 * TURN_STALE_MS ago (a waiter that died with its process). Returns how many were expired.
 */
export function expireStale(now = Date.now()): number {
  const cutoff = new Date(now - TURN_STALE_MS).toISOString();
  return db()
    .update(T)
    .set({ state: "expired" })
    .where(or(and(eq(T.state, "pending"), lt(T.createdAt, cutoff)), and(eq(T.state, "claimed"), lt(T.claimedAt, cutoff))))
    .run().changes;
}

/** Turns of this castle in the given states (newest last). */
export function turnsOf(castleId: string, states: GuardTurnState[], kinds?: GuardTurnKind[]): GuardTurnRow[] {
  const where = [eq(T.castleId, castleId), inArray(T.state, states)];
  if (kinds?.length) where.push(inArray(T.kind, kinds));
  return db().select().from(T).where(and(...where)).orderBy(T.createdAt).all();
}

/**
 * A new lease took over: siege turns the old lease claimed go back to pending (the new harness answers
 * them); self-check and smoke turns of any older lease are expired (the new lease re-runs the checks).
 */
export function handOverTurns(castleId: string, oldLeaseId: string | null): void {
  if (oldLeaseId) {
    db()
      .update(T)
      .set({ state: "pending", leaseId: null, claimedAt: null })
      .where(and(eq(T.castleId, castleId), eq(T.state, "claimed"), eq(T.kind, "siege"), eq(T.leaseId, oldLeaseId)))
      .run();
  }
  db()
    .update(T)
    .set({ state: "expired" })
    .where(and(eq(T.castleId, castleId), inArray(T.state, ["pending", "claimed"] as GuardTurnState[]), inArray(T.kind, ["selfcheck", "smoke"] as GuardTurnKind[])))
    .run();
}
