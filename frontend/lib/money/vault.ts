import type { Castle, TransportKind, VaultState } from "@/lib/types";

/**
 * Vault-state copy and helpers for the UI (pure: no env, no "use client").
 * The rules live in lib/types: only `guarding` castles take sieges.
 */

/** A castle's vault state, tolerating rows from before vault states existed. */
export function vaultStateOf(c: Pick<Castle, "status"> & Partial<Pick<Castle, "vaultState">>): VaultState {
  if (c.vaultState) return c.vaultState;
  return c.status === "open" ? "guarding" : c.status;
}

export const isTerminal = (s: VaultState) => s === "broken" || s === "closed";

/** Setup steps before a vault starts guarding, per transport. */
export const SETUP_STEPS: Record<TransportKind, VaultState[]> = {
  hosted: ["created", "verified", "funded"],
  sdk: ["created", "connected", "verified", "funded"],
};

/** One line on why a castle is not taking sieges (null when it is). */
export function notTakingSiegesReason(state: VaultState | undefined): string | null {
  switch (state) {
    case "guarding":
      return null;
    case "dormant":
      return "The guardian is offline — no sieges until it reconnects.";
    case "broken":
      return "This vault was broken and paid out — no new sieges.";
    case "closed":
      return "This vault is closed — no new sieges.";
    case "created":
    case "connected":
    case "verified":
    case "funded":
      return "This vault is still being set up — not taking sieges yet.";
    default:
      return "This castle isn't taking sieges right now.";
  }
}

const CLOSE_REASON: Record<string, string> = {
  expired: "the deadline passed",
  vault_expired: "the deadline passed",
  orders_changed: "the guardian's orders changed",
  owner_closed: "closed by the Castellan",
};

/** Human text for a `closed` vault's reason ("orders_changed" -> "the guardian's orders changed"). */
export function closeReasonText(reason: string | undefined): string {
  if (!reason) return "closed";
  return CLOSE_REASON[reason] ?? reason.replace(/_/g, " ");
}

/**
 * Why a siege was voided, from its settlement reason (and the castle's current state as a hint):
 *   offline — the guardian went dormant under it;  closed — the vault closed (any reason);
 *   other   — e.g. another raider broke the vault first.
 */
export function voidCause(reason: string | undefined, castleState?: VaultState): "offline" | "closed" | "other" {
  const r = (reason ?? "").toLowerCase();
  if (/dormant|offline|heartbeat/.test(r)) return "offline";
  if (/broken|already|not_open/.test(r)) return "other";
  if (/closed|orders_changed|expired/.test(r)) return "closed";
  if (castleState === "dormant") return "offline";
  if (castleState === "closed") return "closed";
  return "other";
}
