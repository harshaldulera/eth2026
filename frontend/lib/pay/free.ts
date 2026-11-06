import { and, eq, isNull, like, or } from "drizzle-orm";
import type { AccountId } from "@/lib/types";
import { env } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { nowIso, utcDay } from "@/lib/util/ids";

const norm = (wallet: string) => wallet.trim().toLowerCase();

/** Rows for one wallet on one UTC day ("YYYY-MM-DD", then "YYYY-MM-DD#2", … if more than one per day is allowed). */
function todayRows(wallet: string, day: string) {
  const t = schema.freeSieges;
  return db()
    .select()
    .from(t)
    .where(and(eq(t.wallet, wallet), or(eq(t.day, day), like(t.day, `${day}#%`))))
    .all();
}

/**
 * Claim the free daily siege for a wallet (FREE_SIEGES_PER_DAY, default 1, per UTC day).
 * The unique (wallet, day) index makes a concurrent double claim fail instead of double-granting.
 * Free sieges never pay out: the receipt is persisted with free = true and chain.release refuses them.
 */
export async function claimFree(wallet: AccountId): Promise<{ ok: true } | { ok: false; reason: "used_today" }> {
  const w = norm(wallet);
  const perDay = env().FREE_SIEGES_PER_DAY;
  if (!w || perDay <= 0) return { ok: false, reason: "used_today" };
  const day = utcDay();
  try {
    return db().transaction(() => {
      const used = todayRows(w, day).length;
      if (used >= perDay) return { ok: false as const, reason: "used_today" as const };
      db()
        .insert(schema.freeSieges)
        .values({ wallet: w, day: used === 0 ? day : `${day}#${used + 1}`, createdAt: nowIso() })
        .run();
      return { ok: true as const };
    });
  } catch (e) {
    if (e instanceof Error && /UNIQUE/i.test(e.message)) return { ok: false, reason: "used_today" };
    throw e;
  }
}

/** Link today's newest unlinked free claim of `wallet` to the siege it started. */
export function markFreeSiege(wallet: AccountId, siegeId: string): void {
  const w = norm(wallet);
  const day = utcDay();
  const t = schema.freeSieges;
  const row = todayRows(w, day).find((r) => !r.siegeId);
  if (!row) return;
  db()
    .update(t)
    .set({ siegeId })
    .where(and(eq(t.wallet, w), eq(t.day, row.day), isNull(t.siegeId)))
    .run();
}

/** Free sieges left today for a wallet (UI hint). */
export function freeLeftToday(wallet: AccountId): number {
  return Math.max(0, env().FREE_SIEGES_PER_DAY - todayRows(norm(wallet), utcDay()).length);
}
