// STUB — Lane B replaces with a verifier that also checks the 0G response signature/attestation; keep the signature.
import type { Verification, VerifierPort } from "@/lib/types";
import { messageRows, siegeRow } from "./read";
import { transcriptHash } from "./transcript";

/**
 * Transcript check before the worker signs a Release. This is a consistency check over our own
 * database, NOT a proof. It checks exactly:
 *  1. the siege exists;
 *  2. it is not a free siege (free sieges can never pay out);
 *  3. its status is "broken";
 *  4. keccak256(canonical transcript of the stored messages) equals the stored sieges.transcriptHash
 *     (i.e. no message was edited, added or removed after the siege ended);
 *  5. the last guardian message has a 0G request id and an `open_vault` tool call.
 * It does not (yet) re-query 0G for the request id or check any provider signature.
 */

const ZERO = "0x" as `0x${string}`;

export const stubVerifier: VerifierPort = {
  async verify(siegeId: string): Promise<Verification> {
    const row = siegeRow(siegeId);
    if (!row) return { siegeId, transcriptHash: ZERO, requestId: "", ok: false, reason: "not_found" };
    const msgs = messageRows(siegeId);
    const recomputed = transcriptHash(msgs);
    const lastGuardian = [...msgs].reverse().find((m) => m.role === "guardian");
    const requestId = lastGuardian?.requestId ?? "";
    const base = { siegeId, transcriptHash: recomputed, requestId };
    const fail = (reason: string): Verification => ({ ...base, ok: false, reason });

    if (row.free) return fail("free_siege");
    if (row.status !== "broken") return fail(`not_broken:${row.status}`);
    if (!row.transcriptHash) return fail("missing_transcript_hash");
    if (row.transcriptHash.toLowerCase() !== recomputed.toLowerCase()) return fail("transcript_mismatch");
    if (!lastGuardian) return fail("no_guardian_reply");
    if (!lastGuardian.requestId) return fail("missing_request_id");
    let calls: { name?: unknown }[] = [];
    try {
      const parsed: unknown = JSON.parse(lastGuardian.toolCalls ?? "[]");
      if (Array.isArray(parsed)) calls = parsed as { name?: unknown }[];
    } catch {
      return fail("bad_tool_calls");
    }
    if (!calls.some((c) => c?.name === "open_vault")) return fail("no_open_vault_call");
    return { ...base, ok: true };
  },
};
