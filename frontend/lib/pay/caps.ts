import { and, asc, eq, isNotNull, like, ne, sql } from "drizzle-orm";
import type { Amount, CapReason, CapResult } from "@/lib/types";
import { db, schema } from "@/lib/db";
import { newId, nowIso, utcDay } from "@/lib/util/ids";
import { MANUAL_STRATEGY } from "@/lib/agents/manual";

/**
 * Raider-agent spend caps. Everything that decides "may this agent pay?" runs inside ONE
 * synchronous SQLite transaction, and a pass reserves the spend in the same transaction,
 * so two concurrent sieges can never both squeeze under the same cap.
 *
 * Approved approvals raise the cap they were asked for:
 *   per_castle -> that castle's cap for this agent, daily -> today's cap,
 *   budget -> topUpAgent already raised the budget, stop_rule -> the loss counter is reset.
 * An allowance row is marked `consumed` once spend has eaten all of it.
 *
 * Operator accounts (strategy "manual", lib/agents/manual) have none of those caps: they spend what
 * they hold (deposits + breach payouts - spent - reserved), refused as `budget` when short.
 */

const s = schema.agentSpend;
const ap = schema.approvalRequests;
const sumAmount = sql<number>`coalesce(sum(${s.amountTinybar}), 0)`;

type Tx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
type ApprovalRow = typeof schema.approvalRequests.$inferSelect;

function markConsumed(tx: Tx, rows: ApprovalRow[], overflow: number) {
  let cumulative = 0;
  for (const r of rows) {
    cumulative += r.amountTinybar;
    if (!r.consumed && overflow >= cumulative) tx.update(ap).set({ consumed: true }).where(eq(ap.id, r.id)).run();
  }
}

export async function checkCaps(agentId: string, castleId: string, amount: Amount): Promise<CapResult> {
  const amt = Number(amount);
  if (!Number.isSafeInteger(amt) || amt < 0) throw new Error(`checkCaps: invalid amount ${amount}`);
  const day = utcDay();

  return db().transaction((tx): CapResult => {
    const a = tx.select().from(schema.raiderAgents).where(eq(schema.raiderAgents.id, agentId)).get();
    const pending = tx
      .select({ id: ap.id })
      .from(ap)
      .where(and(eq(ap.agentId, agentId), eq(ap.castleId, castleId), eq(ap.status, "pending")))
      .get();
    const refuse = (reason: CapReason): CapResult => ({
      ok: false,
      reason,
      ...(pending ? { approvalRequestId: pending.id } : {}),
    });
    if (!a || a.status === "stopped") return refuse("stopped");

    const castleSpent =
      tx.select({ v: sumAmount }).from(s).where(and(eq(s.agentId, agentId), eq(s.castleId, castleId), ne(s.state, "void"))).get()?.v ?? 0;
    const daySpent =
      tx.select({ v: sumAmount }).from(s).where(and(eq(s.agentId, agentId), eq(s.day, day), ne(s.state, "void"))).get()?.v ?? 0;
    const reserved =
      tx.select({ v: sumAmount }).from(s).where(and(eq(s.agentId, agentId), eq(s.state, "reserved"))).get()?.v ?? 0;

    const castleAllow = tx
      .select()
      .from(ap)
      .where(and(eq(ap.agentId, agentId), eq(ap.castleId, castleId), eq(ap.status, "approved"), eq(ap.reason, "per_castle")))
      .orderBy(asc(ap.resolvedAt))
      .all();
    const dayAllow = tx
      .select()
      .from(ap)
      .where(and(eq(ap.agentId, agentId), eq(ap.status, "approved"), eq(ap.reason, "daily"), like(ap.resolvedAt, `${day}%`)))
      .orderBy(asc(ap.resolvedAt))
      .all();
    const total = (rows: ApprovalRow[]) => rows.reduce((t, r) => t + r.amountTinybar, 0);

    if (a.strategy === MANUAL_STRATEGY) {
      // An operator account (typed ops only): no per-vault / daily cap and no stop rule. It may spend
      // what it holds: every deposit (budget) plus every breach payout released into it, minus what it
      // already paid and what is in flight. So winnings are spendable and a short account is refused.
      const payouts =
        tx
          .select({ v: sql<number>`coalesce(sum(${schema.sieges.releaseAmountTinybar}), 0)` })
          .from(schema.sieges)
          .where(and(eq(schema.sieges.agentId, agentId), isNotNull(schema.sieges.releaseTx)))
          .get()?.v ?? 0;
      if (a.spentTinybar + reserved + amt > a.budgetTinybar + payouts) return refuse("budget");
      const reservationId = newId("spend");
      tx.insert(s).values({ id: reservationId, agentId, castleId, amountTinybar: amt, day, state: "reserved", createdAt: nowIso() }).run();
      return { ok: true, reservationId };
    }

    if (castleSpent + amt > a.perCastleCapTinybar + total(castleAllow)) return refuse("per_castle");
    if (daySpent + amt > a.dailyCapTinybar + total(dayAllow)) return refuse("daily");
    if (a.spentTinybar + reserved + amt > a.budgetTinybar) return refuse("budget");
    if (a.stopAfterLosses > 0 && a.consecutiveLosses >= a.stopAfterLosses) return refuse("stop_rule");

    const reservationId = newId("spend");
    tx.insert(s).values({ id: reservationId, agentId, castleId, amountTinybar: amt, day, state: "reserved", createdAt: nowIso() }).run();
    markConsumed(tx, castleAllow, castleSpent + amt - a.perCastleCapTinybar);
    markConsumed(tx, dayAllow, daySpent + amt - a.dailyCapTinybar);
    return { ok: true, reservationId };
  });
}

/** The x402 payment went through: the reservation becomes real spend. */
export async function settleSpend(
  reservationId: string,
  siegeId: string,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_reserved" }> {
  return db().transaction((tx) => {
    const r = tx.select().from(s).where(eq(s.id, reservationId)).get();
    if (!r) return { ok: false as const, reason: "not_found" as const };
    if (r.state !== "reserved") return { ok: false as const, reason: "not_reserved" as const };
    tx.update(s).set({ state: "settled", siegeId }).where(eq(s.id, reservationId)).run();
    tx.update(schema.raiderAgents)
      .set({ spentTinybar: sql`${schema.raiderAgents.spentTinybar} + ${r.amountTinybar}` })
      .where(eq(schema.raiderAgents.id, r.agentId))
      .run();
    return { ok: true as const };
  });
}

/** The payment never happened (402 refused, network error): release the reservation. */
export async function voidSpend(reservationId: string): Promise<{ ok: boolean }> {
  const res = db()
    .update(s)
    .set({ state: "void" })
    .where(and(eq(s.id, reservationId), eq(s.state, "reserved")))
    .run();
  return { ok: res.changes > 0 };
}

/**
 * The payment outcome is unknown or money moved without a siege (settle timeout -> payment_pending,
 * castle closed after payment, start failed): KEEP the reservation so every cap still counts it, and
 * tie it to the receipt. lib/pay/refunds.ts voids it once the receipt is refunded or proven failed.
 */
export async function holdSpend(reservationId: string, receiptId: string | null): Promise<{ ok: boolean }> {
  const res = db()
    .update(s)
    .set({ receiptId })
    .where(and(eq(s.id, reservationId), eq(s.state, "reserved")))
    .run();
  return { ok: res.changes > 0 };
}

/**
 * After a siege ends: held/banished count as a loss, a break resets the streak of losses.
 * `pressure` (0–100) is echoed back so callers can decide whether to ask the owner for more.
 */
export async function recordOutcome(
  agentId: string,
  castleId: string,
  outcome: "held" | "broken" | "banished",
  pressure: number,
): Promise<{ consecutiveLosses: number; stopRuleHit: boolean; castleId: string; pressure: number } | null> {
  const t = schema.raiderAgents;
  const row = db()
    .update(t)
    .set({ consecutiveLosses: outcome === "broken" ? 0 : sql`${t.consecutiveLosses} + 1` })
    .where(eq(t.id, agentId))
    .returning()
    .get();
  if (!row) return null;
  return {
    consecutiveLosses: row.consecutiveLosses,
    stopRuleHit: row.stopAfterLosses > 0 && row.consecutiveLosses >= row.stopAfterLosses,
    castleId,
    pressure,
  };
}

/** Spend summary for UI / agent prompts. */
export function spendSummary(agentId: string, castleId?: string) {
  const day = utcDay();
  const live = and(eq(s.agentId, agentId), ne(s.state, "void"));
  return {
    today: db().select({ v: sumAmount }).from(s).where(and(live, eq(s.day, day))).get()?.v ?? 0,
    castle: castleId ? (db().select({ v: sumAmount }).from(s).where(and(live, eq(s.castleId, castleId))).get()?.v ?? 0) : 0,
    reserved: db().select({ v: sumAmount }).from(s).where(and(eq(s.agentId, agentId), eq(s.state, "reserved"))).get()?.v ?? 0,
  };
}
