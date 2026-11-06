/**
 * Human text for siege outcomes, shared by the Siege Room and the Replay page (browser-safe).
 * Kept here, with tests, so the two pages can never disagree about what happened.
 */
import type { SiegeSettlement } from "@/lib/types";

/**
 * Every reason the code voids or fails a siege with, in words a raider understands. Sources:
 * lib/siege/stub.ts (lost race), lib/pay/refunds.ts (castle broken / closed / expired, no guardian
 * reply), lib/vault/state.ts (castle closed), worker/agents.ts (guardian unavailable), settlement errors.
 */
export const REASON_TEXT: Record<string, string> = {
  castle_already_broken: "another raider broke this castle moments before you did",
  castle_broken: "another raider broke this castle before your siege finished",
  castle_closed: "the castle's vault closed before your siege finished",
  castle_expired: "the castle's vault expired before your siege finished",
  castle_not_found: "the castle no longer exists",
  vault_expired: "the castle's vault expired before your siege finished",
  vault_not_open: "the vault had already been emptied",
  expired: "the vault had expired",
  dormant: "the guardian went offline",
  guardian_dormant: "the guardian went offline",
  castle_dormant: "the guardian went offline",
  guardian_unavailable: "the guardian could not be reached",
  no_guardian_reply: "the guardian never replied",
  orders_changed: "the guardian's orders changed and the vault closed",
  owner_closed: "the Castellan closed the vault",
};

export const reasonText = (r?: string) => (r ? (REASON_TEXT[r] ?? r.replace(/_/g, " ")) : "unknown error");

/** What happened to the fee of a voided paid siege, said truthfully for every refund state. */
export function refundText(s: { free: boolean; settlement?: SiegeSettlement }): string {
  if (s.free) return "free siege, nothing to refund";
  const r = s.settlement?.refund;
  if (!r) return "fee refund pending";
  if (r.state === "refunded") return "fee refunded";
  if (r.state === "failed") return "fee refund failed, owed by the arena";
  return "fee being refunded";
}

/** The Replay page's headline for a siege. */
export function replayHeadline(
  s: { status: string; turn: number; free: boolean; settlement?: SiegeSettlement },
  guardianName: string,
): string {
  if (s.settlement?.state === "void") {
    const why = reasonText(s.settlement.reason);
    const lead = s.status === "broken" ? `${guardianName} opened the vault, but ${why}` : `Voided: ${why}`;
    return `${lead}. ${capitalize(refundText(s))}.`;
  }
  if (s.status === "broken") return `${guardianName} opened the vault on turn ${s.turn}`;
  if (s.status === "held") return `${guardianName} held for ${s.turn} messages`;
  if (s.status === "banished") return `${guardianName} banished the raider on turn ${s.turn}`;
  return "Siege in progress";
}

const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
