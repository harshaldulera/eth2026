import type { VaultCloseReason, VaultState, VaultStatePort } from "@/lib/types";
import { nowIso } from "@/lib/util/ids";
import { closeCastle } from "./close";
import { transitionVault, vaultStateOf } from "./state";

/** The close reasons a "closed" transition may carry (SiegeVault.CloseReason). */
export const VAULT_CLOSE_REASONS: readonly VaultCloseReason[] = ["expired", "orders_changed", "owner_closed"];

/** States only Lane A's money paths may set: they need a chain write (createVault / release). */
const CHAIN_ONLY: ReadonlySet<VaultState> = new Set<VaultState>(["funded", "broken"]);

/**
 * The shared VaultStatePort (lib/types) — what Lane B calls.
 *   connected / verified / guarding / dormant   plain transitions (lib/vault/state transitionVault)
 *   closed                                      closeCastle(castleId, reason): reason MUST be a
 *                                               VaultCloseReason; the vault closes on chain (pot back
 *                                               to the castellan, in-flight fees refunded) first.
 *                                               Refused with "being_broken" while a paid break waits
 *                                               for its release.
 *   funded / broken                             refused ("illegal_transition"): funded only via
 *                                               fundVault (SiegeVault.createVault), broken only via the
 *                                               worker's verified release.
 */
export const vaultState: VaultStatePort = {
  async get(castleId: string) {
    return vaultStateOf(castleId);
  },
  async transition(castleId: string, to: VaultState, reason: string) {
    if (CHAIN_ONLY.has(to)) return { ok: false, reason: "illegal_transition" };
    if (to !== "closed") return transitionVault(castleId, to, reason);
    const why = VAULT_CLOSE_REASONS.find((r) => r === reason);
    const from = vaultStateOf(castleId);
    if (from == null) return { ok: false, reason: "not_found" };
    if (!why) return { ok: false, reason: "illegal_transition" };
    const r = await closeCastle(castleId, why);
    if (!r.ok) {
      if (r.reason === "not_found") return { ok: false, reason: "not_found" };
      if (r.reason === "being_broken") return { ok: false, reason: "being_broken" };
      if (r.status === 502) return { ok: false, reason: "close_failed" };
      return { ok: false, reason: "illegal_transition" };
    }
    return { ok: true, change: { castleId, from, to: "closed", reason: why, at: nowIso() } };
  },
};
