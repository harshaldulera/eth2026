import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Onboarding credentials (plans/siege-onboarding-plan.md §0 "Keys"). Server only.
 *   ok_  castle owner      stored hashed  (castles.owner_key_hash / vault_drafts.owner_key_hash)
 *   rk_  unit operator     stored hashed  (raider_agents.operator_key_hash / unit_drafts.operator_key_hash)
 *   gk_  SDK guard         stored raw     (castles.guard_key: the harness's Bearer for /api/guard/*)
 *   vk_  vault proxy       stored raw     (castles.vault_key: the harness's Bearer for /api/proxy/v1)
 * A raw key is shown to its holder once and never appears in a response, log, event, Arkiv or HCS.
 */

export type KeyPrefix = "ok" | "rk" | "gk" | "vk";

/** `<prefix>_` + 24 base64url chars (18 random bytes, 144 bits). */
export function newKey(prefix: KeyPrefix): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

/** sha256 hex of the key: what the DB stores for ok_/rk_ keys. */
export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/** Timing-safe equality of two hashes (false when either is missing or the lengths differ). */
export function sameHash(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** True when `key` has the shape `newKey(prefix)` produces (cheap pre-check before any DB lookup). */
export function isKeyOf(prefix: KeyPrefix, key: string | null | undefined): key is string {
  return typeof key === "string" && key.length <= 128 && key.startsWith(`${prefix}_`) && /^[a-z]{2}_[A-Za-z0-9_-]{16,}$/.test(key);
}
