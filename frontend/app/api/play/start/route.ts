import { z } from "zod";
import { demoWalletOps, isStub } from "@/lib/config/env";
import { getCastle } from "@/lib/castles";
import { agentCredentials } from "@/lib/agents/accounts";
import { isManualUnit } from "@/lib/agents/manual";
import { unitBalance } from "@/lib/agents/transfer";
import { checkCaps, createPayerFetch, holdSpend, isSpendControlRefusal, settleSpend, SpendControlError, voidSpend } from "@/lib/pay";
import { STUB_PAYMENT_HEADER } from "@/lib/pay/stub";
import { vaultStateOf } from "@/lib/vault";
import { clientIp, mintBoundReconTicket, RECON_IP_HEADER, RECON_TICKET_HEADER, turnCookie } from "@/lib/auth/turn";
import { err, errorMessage, internalFetch, json, readBody, requireUnitAccess } from "../../_lib/http";

/**
 * POST /api/play/start — the browser's RUN OP / RECON buttons. The SERVER does a real x402 round trip
 * against /api/siege/start (402 -> sign -> retry), so the browser never holds a Hedera key.
 *
 * Every paid op is paid from the operator's OWN account: `{castleId, agentId}` + that unit's operator
 * key (a unit, or an operator account made for typing ops by hand). A paid op without one answers
 * 403 `own_account_required` (fund an operator account first). Stub-only hatch: DEMO_WALLET_OPS (on by
 * default in stub, refused at boot on testnet) keeps the old path, a paid op with no unit paid from the
 * stub demo raider "0.0.stub-raider", for npm run demo / qa:op / tests. Free recon never pays: it goes
 * to /api/siege/start with no payer and no key loaded, and a 402 there is an error, never signed.
 * Returns the siege's `turnToken` in the body AND as an httpOnly cookie scoped to that siege, which the
 * browser's sendMessage sends back automatically. Free recon needs a `visitor`; this route mints the HMAC
 * ticket that /api/siege/start checks and forwards the caller's IP for the per-IP cap.
 *
 * Onboarding J4: `{castleId, agentId}` + the unit's operator key (x-siege-operator-key, or the owner
 * cookie) pays from THAT unit instead of the demo wallet: its own account signs the x402 payment, caps
 * are checked and the spend reserved/settled exactly like the worker's runs (lib/pay/caps), and the
 * siege is attributed to the unit, so a breach pays out to it. Same response shape.
 */

const Body = z.object({
  castleId: z.string().min(1).max(120),
  free: z.boolean().optional(),
  /** J4: pay from this unit (needs its operator key). Never with `free`. */
  agentId: z.string().min(1).max(120).optional(),
  /**
   * Additive (Part 2): a per-browser id for free recon. The once-a-day free claim is keyed by it
   * (as `recon-<visitor>`) instead of the single arena wallet, so one visitor's recon doesn't use up
   * everyone's. Ignored for paid ops.
   */
  visitor: z
    .string()
    .regex(/^[a-z0-9]{6,32}$/)
    .optional(),
});

const STUB_DEMO_RAIDER = "0.0.stub-raider";

/** The stub demo raider (DEMO_WALLET_OPS hatch). Never a real key: the hatch does not exist on testnet. */
function demoRaider(): { accountId: string; privateKey?: string } | null {
  return isStub() && demoWalletOps() ? { accountId: STUB_DEMO_RAIDER } : null;
}

export async function POST(req: Request) {
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;
  const { castleId, free, visitor, agentId } = body.data;

  const castle = getCastle(castleId);
  if (!castle) return err(404, "castle_not_found");
  // Same rule as /api/siege/start, checked before the demo wallet signs anything.
  const state = vaultStateOf(castleId);
  if (state !== "guarding" && castle.status === "open") return err(409, "not_guarding", { vaultState: state });
  if (free && !visitor) return err(403, "recon_requires_visitor", { message: "Free recon needs a visitor id." });
  // Paid ops pay from the operator's own account: no unit, no op (unless the demo-wallet hatch is on).
  if (!free && !agentId && !demoWalletOps()) {
    return err(403, "own_account_required", {
      message: "Every paid op is paid from your own account. Fund an operator account first (deposit from your wallet), then run the op from it.",
    });
  }

  // J4: a unit pays. Authorise, check its caps, reserve the spend (settled / voided below).
  let reservationId: string | null = null;
  let raider: { accountId: string; privateKey?: string } | null;
  if (agentId) {
    if (free) return err(400, "free_not_for_units", { message: "Free recon is not paid from a unit." });
    const gate = requireUnitAccess(req, agentId);
    if (!gate.ok) return gate.res;
    if (gate.agent.status === "stopped") return err(409, "unit_stopped", { message: "This unit is stopped." });
    if (gate.agent.status === "paused") return err(409, "awaiting_approval", { message: "This unit is waiting for its operator's decision." });
    const caps = await checkCaps(agentId, castleId, castle.fee);
    if (!caps.ok) {
      // An operator account is only ever short of money: say how much it holds against the fee.
      const manual = isManualUnit(gate.agent);
      const balance = manual ? await unitBalance(agentId).catch(() => null) : null;
      return err(409, "cap_reached", {
        reason: caps.reason,
        ...(caps.approvalRequestId ? { approvalRequestId: caps.approvalRequestId } : {}),
        ...(manual ? { manual: true, fee: castle.fee, ...(balance !== null ? { balance: balance.toString() } : {}) } : {}),
      });
    }
    reservationId = caps.reservationId;
    raider = agentCredentials(agentId);
  } else if (free) {
    // Free recon: no payer at all (no key is loaded, nothing can sign).
    raider = null;
  } else {
    // Only reachable with the stub-only DEMO_WALLET_OPS hatch (checked above).
    raider = demoRaider();
    if (!raider) return err(503, "demo_raider_not_configured", { message: "Paid ops are paid from your own account (DEMO_WALLET_OPS is stub-only)." });
  }

  // Did a request carrying a payment actually leave? Only then can money have moved.
  let paidSent = false;
  const base = internalFetch();
  const observed = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (h.has("payment-signature") || h.has("x-payment") || h.has(STUB_PAYMENT_HEADER)) paidSent = true;
    return base(input, init);
  }) as typeof fetch;
  // Free recon: the plain fetch. A 402 from the free path is answered below as an error, never paid.
  const payerFetch = raider ? createPayerFetch({ ...raider, perPaymentCap: castle.fee }, observed) : observed;
  const ip = clientIp(req);
  let res: Response;
  try {
    res = await payerFetch(new URL("/api/siege/start", req.url), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        // The caller IP rides in the ticket's HMAC (never the client's own x-forwarded-for, which it controls).
        ...(free && visitor ? { [RECON_IP_HEADER]: ip, [RECON_TICKET_HEADER]: mintBoundReconTicket(visitor, ip) } : {}),
      },
      body: JSON.stringify(free ? { castleId, free: true, wallet: `recon-${visitor}` } : agentId ? { castleId, agentId } : { castleId }),
    });
  } catch (e) {
    if (reservationId) {
      // A payment that went out and never came back may have settled: keep it counted against the caps.
      if (paidSent && !isSpendControlRefusal(e) && !(e instanceof SpendControlError)) await holdSpend(reservationId, null);
      else await voidSpend(reservationId);
    }
    // Stub: SpendControlError. Testnet: the x402 client's "…rejected by spendControls.allowedAssets maxAmountPerPayment…".
    if (e instanceof SpendControlError || isSpendControlRefusal(e)) {
      return err(402, "spend_control", { message: errorMessage(e) });
    }
    return err(502, "payment_failed", { message: errorMessage(e) });
  }

  const data = (await res.json().catch(() => null)) as { siegeId?: string; receipt?: unknown; turnToken?: string; error?: string; receiptId?: string } | null;
  if (reservationId) {
    // Spend follows what the money did (see worker/agents.ts): a siege = settled; paid but no siege = held
    // against its receipt until refunded; nothing charged = released.
    if (res.ok && data?.siegeId) await settleSpend(reservationId, data.siegeId);
    else if (data?.receiptId) await holdSpend(reservationId, data.receiptId);
    else await voidSpend(reservationId);
  }
  if (res.ok && data?.siegeId) {
    const cookie: Record<string, string> = data.turnToken ? { "set-cookie": turnCookie(data.siegeId, data.turnToken, new URL(req.url).protocol === "https:") } : {};
    return json({ siegeId: data.siegeId, receipt: data.receipt, turnToken: data.turnToken }, 200, cookie);
  }
  // Free recon is never paid: a 402 there means the free path refused it (nothing was signed).
  if (free && res.status === 402) return err(502, "recon_not_free", { message: "The free path asked for a payment; recon never pays." });
  // 402 here means the payment itself was rejected after signing.
  if (res.status === 402) return err(502, "payment_failed", { detail: data });
  return json(data && typeof data === "object" && "error" in data ? data : { error: `start_failed_${res.status}`, detail: data }, res.status);
}
