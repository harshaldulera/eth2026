/**
 * Guardian and raider profiles, computed from the server's SQLite copy. These are what the
 * reconciler publishes as `guardianProfile` / `raiderProfile` entities, and what the stub returns.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/config/env";
import type { Profile } from "@/lib/types";

export function guardianProfile(wallet: string): Profile | null {
  const owned = db().select().from(schema.castles).where(eq(schema.castles.owner, wallet)).all();
  if (!owned.length) return null;
  const ids = owned.map((c) => c.id);
  const ended = db()
    .select({ status: schema.sieges.status, free: schema.sieges.free, castleId: schema.sieges.castleId })
    .from(schema.sieges)
    .where(and(inArray(schema.sieges.castleId, ids), isNotNull(schema.sieges.attemptTx)))
    .all();
  const feeBy = new Map(owned.map((c) => [c.id, c.feeTinybar]));
  const bps = env().FEE_SPLIT_CASTELLAN_BPS;
  const earned = ended
    .filter((s) => !s.free && (s.status === "held" || s.status === "banished"))
    .reduce((sum, s) => sum + Math.floor(((feeBy.get(s.castleId) ?? 0) * bps) / 10_000), 0);
  return {
    wallet,
    kind: "guardian",
    sieges: owned.reduce((n, c) => n + c.siegeCount, 0),
    breaks: db()
      .select({ id: schema.sieges.id })
      .from(schema.sieges)
      .where(and(inArray(schema.sieges.castleId, ids), eq(schema.sieges.status, "broken")))
      .all().length,
    streak: Math.max(...owned.map((c) => c.streak)),
    earned: String(earned),
  };
}

export function raiderProfile(wallet: string): Profile | null {
  const rows = db().select().from(schema.sieges).where(eq(schema.sieges.raider, wallet)).orderBy(schema.sieges.createdAt).all();
  if (!rows.length) return null;
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
