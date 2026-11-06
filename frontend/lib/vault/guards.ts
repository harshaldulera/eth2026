import { castleClosedReason, type CastleClosed } from "@/lib/castles";
import { vaultStateOf } from "./state";

export type SiegeBlock = CastleClosed | "not_guarding";

/**
 * Why a castle cannot take (or keep) a paid siege right now, or null. castleClosedReason (broken,
 * closed, expired, being broken) plus the vault lifecycle: only a "guarding" vault takes sieges.
 */
export function siegeBlockedReason(castleId: string, opts: Parameters<typeof castleClosedReason>[1] = {}): SiegeBlock | null {
  const closed = castleClosedReason(castleId, opts);
  if (closed) return closed;
  return vaultStateOf(castleId) === "guarding" ? null : "not_guarding";
}
