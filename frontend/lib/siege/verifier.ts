// STUB — Lane B replaces with a verifier that also checks the 0G response signature/attestation; keep the signature.
import { castleRow } from "@/lib/castles";
import { proxy } from "@/lib/proxy";
import type { Verification, VerifierPort } from "@/lib/types";
import { messageRows, siegeRow } from "./read";
import { transcriptHash } from "./transcript";

/**
 * Break check before the worker signs a Release (plan B4). It verifies from the PROXY's request
 * record, not from whatever the transport reported, and runs the same code for hosted and SDK
 * guardians. This is a consistency check over our own database, NOT a proof. It checks exactly:
 *  1. the siege exists and is not free (free sieges can never pay out);
 *  2. its status is "broken";
 *  3. keccak256(canonical transcript of the stored messages) equals the stored sieges.transcriptHash
 *     (no message was edited, added or removed after the siege ended);
 *  4. the last guardian message carries a request id, and the proxy holds a record for it that was
 *     issued on this vault's model key (record.vaultId == castle id), inside this siege
 *     (record.siegeId), on the last turn (record.turn == siege turn), and whose response carried the
 *     protected tool call (record.protectedToolCalled);
 *  5. the stored raw tool calls of that reply include a call named exactly castle.protectedTool.
 * It does not re-query 0G for the request or check any provider signature or attestation.
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
    const castle = castleRow(row.castleId);
    if (!castle) return fail("castle_not_found");

    const rec = await proxy.record(lastGuardian.requestId);
    if (!rec) return fail("proxy_record_missing");
    if (rec.vaultId !== castle.id) return fail("proxy_record_wrong_vault");
    if (rec.siegeId !== siegeId) return fail("proxy_record_wrong_siege");
    if (rec.turn !== row.turn || lastGuardian.turn !== row.turn) return fail("proxy_record_wrong_turn");
    if (!rec.protectedToolCalled) return fail("protected_tool_not_called");

    let calls: { name?: unknown }[] = [];
    try {
      const parsed: unknown = JSON.parse(lastGuardian.toolCalls ?? "[]");
      if (Array.isArray(parsed)) calls = parsed as { name?: unknown }[];
    } catch {
      return fail("bad_tool_calls");
    }
    if (!calls.some((c) => c?.name === castle.protectedTool)) return fail("no_protected_tool_call");
    return { ...base, ok: true };
  },
};
