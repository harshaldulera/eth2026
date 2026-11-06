/**
 * Human text for op outcomes, shared by the Op room and the Replay page (browser-safe).
 *
 * Words follow lib/vocab: Guard, Owner, Operator, Vault, Op, Breach, Recon, Lockdown. The code's
 * own names (castle, siege, raider, guardian) never reach the screen; a test enforces it.
 *
 * Two voices: "operator" speaks to the person who ran the op, in their own Op room ("before you
 * did"); "public" speaks about the op to anyone else, on the Replay page ("moments earlier").
 *
 * Void reasons come in three shapes, all handled here and tested against the code that writes them:
 *  - fixed codes (castle_broken, guardian_dormant, no_guardian_reply, …);
 *  - `castle_closed_<close reason>` from lib/chain/settle.ts closeVoidReason (owner_closed,
 *    expired, orders_changed);
 *  - `verify:<verifier reason>` from worker/settle.ts when a breach could not be verified.
 */
import type { SiegeSettlement } from "@/lib/types";

export type Voice = "operator" | "public";

/** [operator voice, public voice]. */
const FIXED: Record<string, [string, string]> = {
  castle_already_broken: ["another operator breached this vault moments before you did", "another operator breached this vault moments earlier"],
  castle_being_broken: ["another operator breached this vault moments before you did", "another operator breached this vault moments earlier"],
  castle_broken: ["another operator breached this vault before your op finished", "another operator breached this vault before this op finished"],
  castle_closed: ["the vault closed before your op finished", "the vault closed before this op finished"],
  castle_expired: ["the vault expired before your op finished", "the vault expired before this op finished"],
  castle_not_found: ["the vault no longer exists", "the vault no longer exists"],
  vault_expired: ["the vault expired before your op finished", "the vault expired before this op finished"],
  vault_not_open: ["the vault had closed before your op could settle", "the vault had closed before this op could settle"],
  expired: ["the vault had expired", "the vault had expired"],
  dormant: ["the guard went offline", "the guard went offline"],
  guardian_dormant: ["the guard went offline", "the guard went offline"],
  castle_dormant: ["the guard went offline", "the guard went offline"],
  guardian_unavailable: ["the guard could not be reached", "the guard could not be reached"],
  no_guardian_reply: ["the guard never replied", "the guard never replied"],
  orders_changed: ["the guard's orders changed and the vault closed", "the guard's orders changed and the vault closed"],
  owner_closed: ["the Owner closed the vault", "the Owner closed the vault"],
};

/** How a vault was closed under an op (castle_closed_<reason>). */
const CLOSED_BY: Record<string, string> = {
  owner_closed: "the Owner closed the vault",
  expired: "the vault reached its deadline",
  orders_changed: "the guard's orders changed, so the vault closed",
};

/** Every reason the verifier can give (lib/siege/verifier.ts), in words. */
const VERIFY: Record<string, string> = {
  not_found: "the op could not be found",
  free_siege: "a recon op never pays out",
  missing_transcript_hash: "the op has no transcript hash",
  transcript_mismatch: "the transcript does not match its hash",
  no_guardian_reply: "the guard never replied",
  missing_request_id: "the final reply has no model request id",
  bad_tool_calls: "the final reply's tool calls are unreadable",
  castle_not_found: "the vault no longer exists",
  no_protected_tool_call: "the guard never called the protected tool",
  stub_reply_while_0g: "the reply came from the test guard while the arena runs real models",
  no_proxy_record: "the model proxy has no record of the final reply",
  proxy_record_wrong_castle: "the model record belongs to another vault",
  proxy_record_wrong_siege_or_turn: "the model record belongs to another op or turn",
  proxy_saw_no_open_vault: "the model proxy did not see the protected tool being called",
  prompt_hash_mismatch: "the guard's orders changed since the vault was verified",
  mock_response: "the reply came from the offline test model, which cannot pay out",
};

/** Op status words for not_broken:<status>. */
const STATUS_WORD: Record<string, string> = {
  created: "not started",
  in_progress: "still live",
  held: "the guard held",
  banished: "lockdown",
};

/** The verifier's reason in words (not_broken:<status> included). Unknown codes stay readable. */
export function verifyText(reason?: string): string {
  if (!reason) return "rejected";
  if (reason.startsWith("not_broken:")) {
    const s = reason.slice(11);
    return `the op did not end in a breach (${STATUS_WORD[s] ?? s.replace(/_/g, " ")})`;
  }
  return VERIFY[reason] ?? reason.replace(/_/g, " ");
}

/** Whether a void reason has real words (not just a code with underscores replaced). */
export function isKnownReason(code: string): boolean {
  if (FIXED[code]) return true;
  if (code.startsWith("castle_closed_")) return Boolean(CLOSED_BY[code.slice(14)]);
  if (code.startsWith("verify:")) return Boolean(VERIFY[code.slice(7)]);
  return false;
}

/**
 * Why an op was voided, in the given voice. Unknown codes stay readable.
 *
 * `ended`: the op had already ended (held or lockdown) and was voided before its fee was settled,
 * as closing a vault does (voidInFlightSieges includeEnded). "Before your op finished" would be
 * false for it, so the sentence says "before your op was settled" instead.
 */
export function reasonText(code?: string, voice: Voice = "operator", opts: { ended?: boolean } = {}): string {
  const t = rawReasonText(code, voice);
  if (!opts.ended) return t;
  return t.replace(" before your op finished", " before your op was settled").replace(" before this op finished", " before this op was settled");
}

function rawReasonText(code: string | undefined, voice: Voice): string {
  if (!code) return "unknown error";
  const v = voice === "operator" ? 0 : 1;
  const fixed = FIXED[code];
  if (fixed) return fixed[v];
  if (code.startsWith("castle_closed_")) {
    const by = CLOSED_BY[code.slice(14)];
    if (by) return `${by} before ${voice === "operator" ? "your" : "this"} op finished`;
  }
  if (code.startsWith("verify:")) return `the breach could not be verified: ${verifyText(code.slice(7))}`;
  return code.replace(/_/g, " ");
}

/** An op that ended on its own (held or lockdown) before it was voided. */
const endedOnItsOwn = (status: string) => status === "held" || status === "banished";

/** What happened to the fee of a voided paid op, said truthfully for every refund state. */
export function refundText(s: { free: boolean; settlement?: SiegeSettlement }): string {
  if (s.free) return "recon, nothing to refund";
  const r = s.settlement?.refund;
  if (!r) return "fee refund pending";
  if (r.state === "refunded") return "fee refunded";
  if (r.state === "failed") return "fee refund failed, owed by the arena";
  return "fee being refunded";
}

/** The Replay page's line for a voided op (public voice), or null when the op was not voided. */
export function voidHeadline(s: { status: string; free: boolean; settlement?: SiegeSettlement }, guardName: string): string | null {
  if (s.settlement?.state !== "void") return null;
  const why = reasonText(s.settlement.reason, "public", { ended: endedOnItsOwn(s.status) });
  const lead = s.status === "broken" ? `${guardName} opened the vault, but ${why}` : `Voided: ${why}`;
  return `${lead}. ${capitalize(refundText(s))}.`;
}

/** The Op room's line for a voided op (operator voice). */
export function voidLine(s: { status: string; settlement?: SiegeSettlement }, guardName: string): string {
  const why = reasonText(s.settlement?.reason, "operator", { ended: endedOnItsOwn(s.status) });
  return s.status === "broken" ? `${guardName} opened the vault, but ${why}.` : `${capitalize(why)}.`;
}

/**
 * The vault's state when the arena refuses a message for an op it has not voided yet
 * (castleClosedReason in lib/castles.ts, sent as the 409's `reason`), as the void reason the worker
 * will then write.
 */
const LIVE_CLOSED: Record<string, string> = {
  broken: "castle_broken",
  closed: "castle_closed",
  expired: "castle_expired",
  not_found: "castle_not_found",
};

/**
 * The toast when the arena refuses a message with 409 castle_closed (operator voice). `code` is the
 * op's void reason, or the vault's state when the op is not voided yet. "being_broken" means another
 * operator's breach is still being paid out: this op is paused, not voided, so no refund is promised.
 */
export function voidedToast(s: { free: boolean }, code?: string): string {
  if (code === "being_broken") return "Another operator's breach on this vault is being paid out. Your op is paused until it settles.";
  const why = code ? reasonText(LIVE_CLOSED[code] ?? code, "operator") : "this op has ended";
  return `${capitalize(why)}.${s.free ? "" : " Your fee will be refunded."}`;
}

const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
