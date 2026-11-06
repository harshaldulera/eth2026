import { keccak256, stringToBytes } from "viem";
import { z } from "zod";
import { castleClosedReason } from "@/lib/castles";
import { siege, siegeRow } from "@/lib/siege";
import { auditLater, err, errorMessage, json, readBody } from "../../../_lib/http";

/**
 * POST /api/siege/[id]/message { text } — one raider turn; the guardian replies.
 * The siege engine emits message/decision/end events itself; this route only adds the HCS audit
 * (hashes and ids only — never the text).
 */

const Body = z.object({ text: z.string().trim().min(1).max(2000) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;

  // The vault this siege plays for is gone (another raider broke it, or it closed): no more turns.
  // The worker voids the siege and refunds a paid fee.
  const row = siegeRow(id);
  if (row?.status === "in_progress") {
    if (row.voidReason) return err(409, "castle_closed", { reason: row.voidReason });
    const closed = castleClosedReason(row.castleId, { exceptSiegeId: id });
    if (closed) return err(409, "castle_closed", { reason: closed, message: "The castle fell before your siege finished. Your fee will be refunded." });
  }

  let r;
  try {
    r = await siege.message(id, body.data.text);
  } catch (e) {
    console.error(`[siege/message] guardian failed for ${id}:`, errorMessage(e));
    return err(502, "guardian_unavailable", { message: "The guardian did not answer. Your turn was not used; try again." });
  }
  if (!r.ok) return err(r.reason === "not_found" ? 404 : 409, r.reason);

  const { siege: s, decision } = r;
  const turn = s.turn;
  // Plan A4: siege.message carries the turn, the message hash, the proxy request id and the transport.
  const transport = s.transport ?? row?.transport;
  auditLater({
    siegeId: s.id,
    castleId: s.castleId,
    type: "message",
    turn,
    transport,
    requestId: decision.requestId,
    // stringToBytes: always the UTF-8 bytes (toBytes would hex-decode a message like "0x12").
    payload: { hash: keccak256(stringToBytes(body.data.text)), requestId: decision.requestId },
  });
  if (s.status !== "in_progress" && s.transcriptHash) {
    auditLater({
      siegeId: s.id,
      castleId: s.castleId,
      type: "end",
      turn,
      transport,
      requestId: decision.requestId,
      payload: { transcriptHash: s.transcriptHash, requestId: decision.requestId },
    });
  }

  const { raw: _raw, ...publicDecision } = decision;
  void _raw;
  return json({ siege: s, decision: publicDecision });
}
