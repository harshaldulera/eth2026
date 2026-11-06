import type { VaultState } from "@/lib/types";

/**
 * siege.start refused: the castle's vault is not `guarding` (only guarding castles take sieges).
 * Defensive — the start route already refuses non-guarding castles (castleClosedReason
 * "not_guarding") before taking a fee. A route can map this to 409 { error: "castle_not_guarding" }.
 */
export class CastleNotGuardingError extends Error {
  readonly code = "castle_not_guarding";
  constructor(
    readonly castleId: string,
    readonly vaultState: VaultState,
  ) {
    super(`siege.start: castle ${castleId} is ${vaultState}, not guarding`);
    this.name = "CastleNotGuardingError";
  }
}
