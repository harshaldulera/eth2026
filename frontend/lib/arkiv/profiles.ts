/**
 * Guardian and raider profiles, computed from the server's SQLite copy. These are what the
 * reconciler publishes as `guardianProfile` / `raiderProfile` entities, what the leaderboard ranks,
 * and what the stub returns.
 *
 * Only sieges that count are counted: PAID and NOT VOIDED. A free practice siege is unlimited (keyed
 * by an unproven wallet), so counting it would let anyone farm the board. A voided siege (lost a
 * race, could not be verified, castle closed under it) paid nothing and decided nothing.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/config/env";
import type { Profile } from "@/lib/types";

const S = schema.sieges;
const counted = and(eq(S.free, false), isNull(S.voidReason));

export function guardianProfile(wallet: string): Profile | null {
  const owned = db().select().from(schema.castles).where(eq(schema.castles.owner, wallet)).all();
  if (!owned.length) return null;
  const ids = owned.map((c) => c.id);
  const sieges = db()
    .select({ status: S.status, castleId: S.castleId, attemptTx: S.attemptTx })
    .from(S)
    .where(and(inArray(S.castleId, ids), counted))
    .all();
  const feeBy = new Map(owned.map((c) => [c.id, c.feeTinybar]));
  const bps = env().FEE_SPLIT_CASTELLAN_BPS;
  // The Castellan's cut is real once the fee split landed on chain (attemptTx).
  const earned = sieges
    .filter((s) => s.attemptTx && (s.status === "held" || s.status === "banished"))
    .reduce((sum, s) => sum + Math.floor(((feeBy.get(s.castleId) ?? 0) * bps) / 10_000), 0);
  return {
    wallet,
    kind: "guardian",
    sieges: sieges.filter((s) => s.status !== "created").length,
    breaks: sieges.filter((s) => s.status === "broken").length,
    // The castle's own record (seeded history included): consecutive paid sieges held.
    streak: Math.max(...owned.map((c) => c.streak)),
    earned: String(earned),
  };
}

export function raiderProfile(wallet: string): Profile | null {
  const rows = db().select().from(S).where(and(eq(S.raider, wallet), counted)).orderBy(S.createdAt).all();
  if (!rows.length) return null;
  // Streak: consecutive breaks, newest run; a held or banished siege ends it.
  let streak = 0;
  for (const r of rows) {
    if (r.status === "broken") streak += 1;
    else if (r.status === "held" || r.status === "banished") streak = 0;
  }
  return {
    wallet,
    kind: "raider",
    sieges: rows.length,
    breaks: rows.filter((r) => r.status === "broken").length,
    streak,
    earned: String(rows.reduce((n, r) => n + (r.releaseAmountTinybar ?? 0), 0)),
  };
}
