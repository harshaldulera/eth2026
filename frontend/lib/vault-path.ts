/**
 * Public vault URLs read "vault" all the way through: /vault/<slug>, where the slug is the castle id
 * without its legacy "castle_" prefix (castle_splinter_gate → /vault/splinter_gate). Ids, HCS memos and
 * Arkiv entities keep "castle_", and /castle/<id> keeps working for old links and replays.
 */
export const VAULT_ID_PREFIX = "castle_";

/** The share-friendly path for a vault: /vault/<slug>. */
export function vaultPath(castleId: string): string {
  return `/vault/${castleId.startsWith(VAULT_ID_PREFIX) ? castleId.slice(VAULT_ID_PREFIX.length) : castleId}`;
}

/** Back from a URL segment (a slug from /vault/… or a full id from /castle/…) to the castle id. */
export function castleIdFromSlug(slug: string): string {
  const s = decodeURIComponent(slug);
  return s.startsWith(VAULT_ID_PREFIX) ? s : `${VAULT_ID_PREFIX}${s}`;
}
