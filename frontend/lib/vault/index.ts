/**
 * lib/vault — the vault lifecycle (shared by Lane A and Lane B; see state.ts for the rules).
 *   vaultState.transition / get     the VaultStatePort (DB + event + HCS "vault.state" + Arkiv); the
 *                                   cross-lane API: refuses funded/broken, routes closed to closeCastle
 *   transitionVault                 RAW transition, no chain writes: lib/vault, the worker and seed only
 *   isGuarding / siegeBlockedReason only guarding castles take sieges
 *   fundVault                       verified -> funded (SiegeVault.createVault with protectedTool)
 *   closeCastle                     -> closed (SiegeVault.closeVault, in-flight fees refunded); the
 *                                   cross-lane close (Lane B's orders_changed hook calls this)
 */
export { vaultState, VAULT_CLOSE_REASONS } from "./port";
export {
  transitionVault,
  vaultStateOf,
  isGuarding,
  isLegalTransition,
  castleStatusFor,
  VAULT_STATES,
  TERMINAL_STATES,
  DORMANT_VOID_REASON,
  type TransitionOpts,
  type TransitionResult,
} from "./state";
export { siegeBlockedReason, type SiegeBlock } from "./guards";
export { fundVault, DEFAULT_VAULT_DAYS, type FundResult } from "./fund";
export { closeCastle, closeExpiredVaults, type CloseResult } from "./close";
