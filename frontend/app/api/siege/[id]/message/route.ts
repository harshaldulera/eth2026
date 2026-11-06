import { z } from "zod";
import { castleClosedReason } from "@/lib/castles";
import { siege, siegeRow } from "@/lib/siege";
import { TransportUnavailableError } from "@/lib/transport";
import { vaultStateOf } from "@/lib/vault";
import { eventsSince } from "@/lib/events/bus";
import { turnTokenCandidates, turnTokenOk } from "@/lib/auth/turn";
import { err, errorMessage, json, readBody } from "../../../_lib/http";

/**
 * POST /api/siege/[id]/message { text } — one raider turn; the guardian replies.
 * Needs the siege's turn token (Authorization Bearer, x-siege-turn-token, body.turnToken or the siege_turn_<id>
 * cookie) whenever the row has a hash: 401 turn_token_required. Rows without a hash (started before tokens) stay open.
 * The siege engine emits message/decision/end events itself. The HCS audit (siege.message with the
 * message hash, siege.end with the transcript hash) is derived from those persisted events by the audit
 * outbox (lib/chain/outbox.ts), in the order the engine emitted them, so the final turn's siege.message
 * always precedes siege.end and whatever the worker settles after it.
 */

const Body = z.object({ text: z.string().trim().min(1).max(2000), turnToken: z.string().max(200).optional() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;

  // The vault this siege plays for is gone (another raider broke it, or it closed): no more turns.
  // The worker voids the siege and refunds a paid fee.
  const row = siegeRow(id);
  if (row && !turnTokenOk(row.turnTokenHash, turnTokenCandidates(req, id, body.data.turnToken))) {
    return err(401, "turn_token_required", { message: "Send the turnToken returned when this siege started (Authorization: Bearer, x-siege-turn-token, or the siege cookie)." });
  }
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
    // The castle's guardian is gone (an SDK harness went dormant): not a transient error, the vault is not guarding.
    if (e instanceof TransportUnavailableError)
      return err(409, "not_guarding", {
        vaultState: vaultStateOf(e.castleId),
        message: "The guardian is offline, so this castle is not taking turns. Your turn was not used; a paid fee is refunded if the vault goes dormant.",
      });
    return err(502, "guardian_unavailable", { message: "The guardian did not answer. Your turn was not used; try again." });
  }
  if (!r.ok) return err(r.reason === "not_found" ? 404 : 409, r.reason);

  const { siege: s, decision } = r;
  const { raw: _raw, ...publicDecision } = decision;
  void _raw;
  return json({ siege: s, decision: publicDecision, referee: refereeFor(id, s.turn) });
}

/**
 * ADDITIVE (Part 2): the referee's read of this turn — threat 0–100 and the tactic label — from the
 * latest "message" event the engine just emitted, so the op room can play the class effect without
 * waiting for the next event poll. Display only; absent if the event is missing.
 */
function refereeFor(siegeId: string, turn: number): { pressure: number; tactic: string } | undefined {
  const evs = eventsSince(0, { siegeId });
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.type !== "message" || (e.turn !== undefined && e.turn !== turn)) continue;
    const { pressure, tactic } = e.payload ?? {};
    if (typeof pressure === "number") return { pressure, tactic: typeof tactic === "string" ? tactic : "probing" };
  }
  return undefined;
}
