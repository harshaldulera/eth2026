import { castleRow } from "@/lib/castles";
import * as proxy from "@/lib/proxy";
import { guardianMode, PROTECTED_TOOL, systemPrompt } from "@/lib/transport";
import type { Verification, VerifierPort } from "@/lib/types";
import { messageRows, siegeRow } from "./read";
import { transcriptHash } from "./transcript";

/**
 * Check before the worker signs a Release. A consistency check over our own records, NOT a proof.
 * It checks exactly:
 *  1. the siege exists;
 *  2. it is not a free siege (free sieges can never pay out);
 *  3. its status is "broken";
 *  4. keccak256(canonical transcript of the stored messages) equals sieges.transcriptHash
 *     (no message was edited, added or removed after the siege ended);
 *  5. the last guardian message has a request id and an `open_vault` tool call;
 *  6. for a 0G-backed guardian, the 0G proxy's record for that request id
 *     a. exists, b. was made on this castle's key, c. inside this siege on that turn,
 *     d. saw a real `open_vault` call in 0G's response, e. sent this castle's system prompt (hash),
 *     f. was a real 0G call, not the offline mock (unless ZG_ALLOW_MOCK_VERIFY=1);
 *     stub request ids ("0g-stub-…") are accepted only while the stub guardian is in use.
 * It does not check a 0G TEE attestation: the router offers none for chat models yet.
 */

const ZERO = "0x" as `0x${string}`;

export const zeroGVerifier: VerifierPort = {
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
    if (!calls.some((c) => c?.name === PROTECTED_TOOL)) return fail("no_open_vault_call");

    if (requestId.startsWith("0g-stub-")) return guardianMode() === "stub" ? { ...base, ok: true } : fail("stub_reply_while_0g");

    const rec = proxy.record(requestId);
    if (!rec) return fail("no_proxy_record");
    if (rec.castleId !== row.castleId) return fail("proxy_record_wrong_castle");
    if (rec.siegeId !== siegeId || rec.turn !== lastGuardian.turn) return fail("proxy_record_wrong_siege_or_turn");
    if (!rec.protectedToolCalled) return fail("proxy_saw_no_open_vault");
    const castle = castleRow(row.castleId);
    if (!castle) return fail("castle_not_found");
    const expected = proxy.sha256(systemPrompt({ tier: castle.tier, personality: castle.personality, guardianName: castle.guardianName, orders: castle.orders }));
    if (rec.promptHash !== expected) return fail("prompt_hash_mismatch");
    if (rec.mock && process.env.ZG_ALLOW_MOCK_VERIFY !== "1") return fail("mock_response");
    return { ...base, ok: true };
  },
};
