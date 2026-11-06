import { and, eq, isNull } from "drizzle-orm";
import { isKeyOf, newKey } from "@/lib/auth/keys";
import { db, schema } from "@/lib/db";
import { forgetCastleKey } from "@/lib/proxy";

/**
 * SDK guard credentials (plan §2A). Both stored raw on the castle row:
 *   gk_  castles.guard_key  the harness's Bearer for /api/guard/*
 *   vk_  castles.vault_key  the harness's Bearer for /api/proxy/v1 (lib/proxy issueKey / vaultForKey)
 * Never returned by any route except the one-time reveal (guard-key rotation, publish, seed output).
 */

const C = schema.castles;

export type GuardCastleRow = typeof schema.castles.$inferSelect;

/** The castle row whose guard_key is `gk` (raw row incl. secrets: server only), or null. */
export function castleForGuardKey(gk: string | null | undefined): GuardCastleRow | null {
  if (!isKeyOf("gk", gk)) return null;
  return db().select().from(C).where(eq(C.guardKey, gk)).get() ?? null;
}

/** The `gk_` Bearer on a request (Authorization: Bearer gk_…), or null. */
export function readGuardKey(req: Request): string | null {
  const k = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  return isKeyOf("gk", k) ? k : null;
}

/**
 * New guard key for the castle; the old one stops working at once. The vault (proxy) key rotates with
 * it: a leaked harness's vk_ could otherwise still write proxy records that open the vault. The new
 * harness gets the new vk_ from GET /api/guard/hello. Returns the guard key (show it once) or null.
 */
export function rotateGuardKey(castleId: string): string | null {
  const key = newKey("gk");
  const r = db().update(C).set({ guardKey: key, vaultKey: newKey("vk") }).where(eq(C.id, castleId)).run();
  if (r.changes !== 1) return null;
  forgetCastleKey(castleId);
  return key;
}

/**
 * Make sure the castle has a guard key and a vault key (publish / seed). Existing keys are kept.
 * Returns both (server-side callers decide what to reveal), or null for an unknown castle.
 */
export function provisionGuardKeys(castleId: string): { guardKey: string; vaultKey: string } | null {
  db().update(C).set({ guardKey: newKey("gk") }).where(and(eq(C.id, castleId), isNull(C.guardKey))).run();
  db().update(C).set({ vaultKey: newKey("vk") }).where(and(eq(C.id, castleId), isNull(C.vaultKey))).run();
  const row = db().select({ g: C.guardKey, v: C.vaultKey }).from(C).where(eq(C.id, castleId)).get();
  return row?.g && row.v ? { guardKey: row.g, vaultKey: row.v } : null;
}
