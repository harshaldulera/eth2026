import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, ResourceInfo, SettleResponse, VerifyResponse } from "@x402/core/types";
import type { Castle, GateResult } from "@/lib/types";
import { isStub, required } from "@/lib/config/env";
import { txUrl } from "@/lib/chain/hashscan";
import { asset, payNetwork } from "./asset";
import { claimPayment, finalizeClaim, markPendingSettlement, releaseClaim, type ReceiptInput } from "./receipts";
import { stubGate } from "./stub";
import { resourceServer, type GateServer } from "./x402";

/**
 * The x402 gate for a paid siege.
 *
 * Testnet: build requirements (HBAR as an AssetAmount, never a "$" string), answer 402 when the
 * request carries no PAYMENT-SIGNATURE, otherwise verify with the facilitator and settle BEFORE the
 * siege starts. Stub: see ./stub.ts (the stub header is never honoured here in testnet mode).
 *
 * Money safety (testnet):
 *  - the payload's Hedera transaction id is CLAIMED (unique payment_receipts.tx_id) before verify,
 *    so the same PAYMENT-SIGNATURE replayed concurrently is refused (402 payment_already_used);
 *  - an ambiguous settle (facilitator timeout, transport error, "transaction_failed") is resolved on
 *    the mirror node right away; if still unknown the claim becomes a `pending_settlement` receipt
 *    (502 payment_pending + receiptId) that the worker resolves later and refunds if it landed.
 * The ok receipt carries `receiptId` (the claimed row): persistReceipt reuses it.
 */
export async function gate(req: Request, p: { castle: Castle; description: string }): Promise<GateResult> {
  if (isStub()) return stubGate(req, p);
  return realGate(req, p);
}

const NO_STORE = { "cache-control": "no-store" };

function facilitatorDown(message: string, detail?: unknown): GateResult {
  return {
    ok: false,
    status: 502,
    body: { error: "facilitator_error", message, detail: detail instanceof Error ? detail.message : detail },
    headers: NO_STORE,
  };
}

/** Mirror polling for an ambiguous settle (tests shorten it). */
const g = globalThis as unknown as { __siegeGatePoll?: { tries: number; delayMs: number } };
export function __setGatePollForTests(p: { tries: number; delayMs: number } | null) {
  g.__siegeGatePoll = p ?? undefined;
}
const pollCfg = () => g.__siegeGatePoll ?? { tries: 6, delayMs: 2000 };

/** The Hedera transaction id inside an exact-scheme payload ("0.0.x@sec.nanos"), or null. */
export async function payloadTxId(payload: PaymentPayload): Promise<string | null> {
  const tx = (payload.payload as { transaction?: unknown } | undefined)?.transaction;
  if (typeof tx !== "string" || !tx) return null;
  try {
    const { inspectHederaTransaction } = await import("@x402/hedera");
    return inspectHederaTransaction(tx).transactionId ?? null;
  } catch {
    return null;
  }
}

/** Did this tx reach consensus? Polls the mirror a few times. */
async function settledOnMirror(txId: string): Promise<"success" | "failed" | "unknown"> {
  const { transactionResult } = await import("@/lib/chain/mirror");
  const { tries, delayMs } = pollCfg();
  for (let i = 0; i < tries; i++) {
    try {
      const r = await transactionResult(txId);
      if (r.state !== "unknown") return r.state;
    } catch {
      /* mirror hiccup: keep polling */
    }
    if (i < tries - 1) await new Promise((res) => setTimeout(res, delayMs));
  }
  return "unknown";
}

/** Settle reasons that mean the transfer was never submitted (safe to treat as "no money moved"). */
const settleNeverSubmitted = (reason: string) => reason !== "transaction_failed" && !/unexpected|timeout|network/i.test(reason);

function isTimeout(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  return e.name === "FacilitatorTimeoutError" || e.name === "AbortError" || e.name === "TimeoutError" || "operation" in e;
}

async function paymentRequired(
  server: GateServer,
  reqs: PaymentRequirements[],
  resource: ResourceInfo,
  error?: string,
  payload?: PaymentPayload,
): Promise<GateResult> {
  const body = await server.createPaymentRequiredResponse(reqs, resource, error, undefined, undefined, payload);
  return {
    ok: false,
    status: 402,
    body,
    headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body), ...NO_STORE },
  };
}

async function realGate(req: Request, p: { castle: Castle; description: string }): Promise<GateResult> {
  const resource: ResourceInfo = { url: req.url, description: p.description, mimeType: "application/json" };

  let server: GateServer;
  let reqs: PaymentRequirements[];
  try {
    server = await resourceServer();
    reqs = await server.buildPaymentRequirements({
      scheme: "exact",
      network: payNetwork(),
      payTo: required("X402_PAY_TO"),
      price: { asset: asset().id, amount: p.castle.fee },
      maxTimeoutSeconds: 180,
    });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("Missing env")) throw e;
    return facilitatorDown("Could not reach the x402 facilitator to price this siege. Try again shortly.", e);
  }

  const header = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
  if (!header) return paymentRequired(server, reqs, resource);

  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    return paymentRequired(server, reqs, resource, "invalid_payment_header");
  }

  const matching = server.findMatchingRequirements(reqs, payload);
  if (!matching) return paymentRequired(server, reqs, resource, "no_matching_payment_requirements", payload);

  // One payload, one siege: claim its transaction id before anything else.
  const claimTx = await payloadTxId(payload);
  let claimId: string | null = null;
  if (claimTx) {
    const claim = claimPayment({ txId: claimTx, amount: p.castle.fee, asset: matching.asset, network: matching.network, hashscanUrl: txUrl(claimTx) });
    if (!claim.ok) return paymentRequired(server, reqs, resource, "payment_already_used", payload);
    claimId = claim.id;
  }
  const drop = () => {
    if (claimId) releaseClaim(claimId);
  };

  let verify: VerifyResponse;
  try {
    verify = await server.verifyPayment(payload, matching);
  } catch (e) {
    drop();
    if (isTimeout(e)) return facilitatorDown("The x402 facilitator timed out verifying the payment. Nothing was charged; retry.", e);
    const reason = (e as { invalidReason?: string }).invalidReason;
    if (reason) return paymentRequired(server, reqs, resource, reason, payload);
    return facilitatorDown("The x402 facilitator failed to verify the payment.", e);
  }
  if (!verify.isValid) {
    drop();
    return paymentRequired(server, reqs, resource, verify.invalidReason ?? "invalid_payment", payload);
  }

  const success = (transaction: string, payer: string, network: string, settle: SettleResponse): GateResult => {
    const receipt: ReceiptInput & { free: false } = {
      free: false,
      txId: transaction,
      payer,
      amount: p.castle.fee,
      asset: matching.asset,
      network,
      hashscanUrl: txUrl(transaction),
      ...(claimId ? { receiptId: claimId } : {}),
    };
    if (claimId) finalizeClaim(claimId, { txId: transaction, payer, network, hashscanUrl: receipt.hashscanUrl });
    return { ok: true, receipt, headers: { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle) } };
  };

  /** Settle did not clearly succeed or fail: ask the mirror, else park it for the worker. */
  const ambiguous = async (why: string, detail?: unknown): Promise<GateResult> => {
    const payer = verify.payer || undefined;
    if (!claimTx || !claimId) {
      return facilitatorDown(
        `${why} The transfer may still land on Hedera: check HashScan for the payer account before paying again.`,
        detail,
      );
    }
    const state = await settledOnMirror(claimTx);
    if (state === "success") {
      const network = matching.network;
      return success(claimTx, payer ?? "unknown", network, { success: true, transaction: claimTx, network, payer } as SettleResponse);
    }
    if (state === "failed") {
      drop();
      return paymentRequired(server, reqs, resource, "settlement_failed", payload);
    }
    markPendingSettlement(claimId, { payer, note: why });
    return {
      ok: false,
      status: 502,
      body: {
        error: "payment_pending",
        message: `${why} Your payment ${claimTx} has not shown up on Hedera yet. Do not pay again: if it lands without a siege it is refunded automatically.`,
        receiptId: claimId,
        txId: claimTx,
        detail: detail instanceof Error ? detail.message : detail,
      },
      headers: NO_STORE,
    };
  };

  let settle: SettleResponse;
  try {
    settle = await server.settlePayment(payload, matching);
  } catch (e) {
    const reason = (e as { errorReason?: string }).errorReason;
    if (reason && !isTimeout(e) && settleNeverSubmitted(reason)) {
      drop();
      return paymentRequired(server, reqs, resource, reason, payload);
    }
    return ambiguous(
      isTimeout(e) ? "The x402 facilitator timed out while settling." : "The x402 facilitator failed while settling.",
      e,
    );
  }
  if (!settle.success) {
    const reason = settle.errorReason ?? "settlement_failed";
    if (settleNeverSubmitted(reason)) {
      drop();
      return paymentRequired(server, reqs, resource, reason, payload);
    }
    return ambiguous(`Settlement reported ${reason}.`, settle.errorMessage);
  }

  return success(settle.transaction, settle.payer ?? verify.payer ?? "unknown", settle.network ?? matching.network, settle);
}
