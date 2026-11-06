import { z } from "zod";
import { getCastle } from "@/lib/castles";
import { getAgent } from "@/lib/agents/accounts";
import { attachReceipt, claimRecon, DuplicatePaymentError, markFreeSiege, markRefundDue, pay, persistReceipt } from "@/lib/pay";
import { CastleNotGuardingError, siege } from "@/lib/siege";
import type { FreeReceipt, PaidReceipt } from "@/lib/types";
import { siegeBlockedReason, vaultStateOf } from "@/lib/vault";
import {
  clientIp,
  hashTurnToken,
  newTurnToken,
  RECON_IP_HEADER,
  RECON_TICKET_HEADER,
  verifyBoundReconTicket,
  verifyReconTicket,
  visitorOfWallet,
} from "@/lib/auth/turn";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";
import { err, errorMessage, json, readBody } from "../../_lib/http";

/**
 * POST /api/siege/start — THE x402-gated endpoint. Any outside agent can call it:
 *   no payment  -> 402 + PAYMENT-REQUIRED (x402 v2 PaymentRequired body)
 *   paid        -> 200 { siegeId, siege, receipt } + PAYMENT-RESPONSE
 *   free: true  -> free recon (never pays out): wallet must be `recon-<visitor>` AND the request must carry the
 *                  x-siege-recon-ticket HMAC that /api/play/start mints (403 recon_requires_visitor otherwise);
 *                  capped per visitor, per IP and arena-wide per UTC day (429 free_used {scope})
 * Every 200 carries `turnToken` once: POST /api/siege/[id]/message needs it (only its hash is stored).
 * Order matters: the receipt is persisted BEFORE the siege starts, so a crash after a settled
 * payment leaves a receipt row we can reconcile. Money that moved without buying a siege (castle won
 * or closed during the payment, start failed) is marked refund_due and refunded by the worker; the
 * response carries the receiptId. A settled transaction can buy only one siege (409 payment_already_used).
 * Only a "guarding" vault takes sieges: any other vault state -> 409 { error: "not_guarding", vaultState }
 * before any payment is asked for (and re-checked after settle: a vault that stopped guarding while the
 * payment settled refunds the fee).
 */

const Body = z.object({
  castleId: z.string().min(1).max(120),
  agentId: z.string().min(1).max(120).optional(),
  free: z.boolean().optional(),
  wallet: z.string().min(1).max(120).optional(),
});

export async function POST(req: Request) {
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;
  const { castleId, agentId, free, wallet } = body.data;

  const castle = getCastle(castleId);
  if (!castle) return err(404, "castle_not_found");
  // Not just `status`: a paid siege that ended broken has already won the vault (the worker flips the
  // status only once the release lands), so no new fee is taken for it.
  // Not guarding (created / connecting / unfunded / dormant…): nobody is asked to pay.
  const closed = siegeBlockedReason(castleId);
  if (closed === "not_guarding") return err(409, "not_guarding", { vaultState: vaultStateOf(castleId) });
  if (closed) return err(409, "castle_not_open", { status: closed === "being_broken" ? "broken" : closed });

  let receipt: Omit<PaidReceipt, "siegeId"> | Omit<FreeReceipt, "siegeId">;
  let headers: Record<string, string> = {};
  if (free) {
    const visitor = visitorOfWallet(wallet);
    // play/start binds the ticket to the caller IP it saw (x-siege-recon-ip); an unbound ticket (in-process
    // callers) falls back to this request's own trusted client IP.
    const ticket = req.headers.get(RECON_TICKET_HEADER);
    const boundIp = req.headers.get(RECON_IP_HEADER)?.trim().toLowerCase().slice(0, 64);
    const ok = visitor && (boundIp ? verifyBoundReconTicket(visitor, boundIp, ticket) : verifyReconTicket(visitor, ticket));
    if (!visitor || !ok) {
      return err(403, "recon_requires_visitor", { message: "Free recon is for browser visitors: start it from the Grid." });
    }
    const claim = claimRecon({ visitor, ip: boundIp || clientIp(req) });
    if (!claim.ok) return err(429, "free_used", { scope: claim.scope });
    receipt = { free: true, payer: wallet! };
  } else {
    const g = await pay.gate(req, {
      castle,
      description: `Siege on ${castle.name} — 5 messages to talk ${castle.guardianName} into opening the vault`,
    });
    if (!g.ok) return Response.json(g.body, { status: g.status, headers: g.headers });
    receipt = g.receipt;
    headers = g.headers;
  }

  // Attribute the siege to an agent only when the agent itself paid (its account is the payer).
  const agent = agentId ? getAgent(agentId) : null;
  const attributed = agent && !receipt.free && agent.accountId === receipt.payer ? agent.id : undefined;

  let receiptId: string;
  try {
    receiptId = persistReceipt(receipt);
  } catch (e) {
    if (e instanceof DuplicatePaymentError) return err(409, "payment_already_used", { txId: e.txId });
    throw e;
  }

  // The payment took seconds: the castle may have fallen (or closed) meanwhile. Never start a siege
  // that cannot pay out; refund the fee instead.
  const closedNow = receipt.free ? null : siegeBlockedReason(castleId);
  if (closedNow === "not_guarding") {
    markRefundDue(receiptId, `vault stopped guarding (${vaultStateOf(castleId)}) before the siege could start`);
    return err(409, "not_guarding", {
      vaultState: vaultStateOf(castleId),
      receiptId,
      refund: "due",
      message: "The guardian stopped guarding while your payment settled. Your fee will be refunded.",
    });
  }
  if (closedNow) {
    markRefundDue(receiptId, `castle ${closedNow} before the siege could start`);
    return err(409, "castle_not_open", {
      status: closedNow === "being_broken" ? "broken" : closedNow,
      receiptId,
      refund: "due",
      message: "The castle fell while your payment settled. Your fee will be refunded.",
    });
  }

  let started;
  try {
    started = await siege.start({ castleId, raider: receipt.payer, receipt, agentId: attributed, receiptId });
  } catch (e) {
    console.error(`[siege/start] start failed after payment (receipt ${receiptId}):`, errorMessage(e));
    if (!receipt.free) markRefundDue(receiptId, `siege start failed: ${errorMessage(e)}`);
    if (e instanceof CastleNotGuardingError) {
      return err(409, "not_guarding", { vaultState: e.vaultState, receiptId, refund: receipt.free ? undefined : "due" });
    }
    return err(500, "start_failed", { receiptId, refund: receipt.free ? undefined : "due", message: errorMessage(e) });
  }
  attachReceipt(receiptId, started.id);
  // The raider's only handle on this siege's turns. Minted here (not in lib/siege) and stored as a hash.
  const turnToken = newTurnToken();
  db().update(schema.sieges).set({ turnTokenHash: hashTurnToken(turnToken) }).where(eq(schema.sieges.id, started.id)).run();
  if (receipt.free) markFreeSiege(receipt.payer, started.id);

  // HCS siege.start is derived from the engine's "start" event by the audit outbox (lib/chain/outbox.ts).
  return json({ siegeId: started.id, siege: started, receipt, turnToken }, 200, headers);
}
