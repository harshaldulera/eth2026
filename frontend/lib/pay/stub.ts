import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequired } from "@x402/core/types";
import type { Castle, GateResult } from "@/lib/types";
import { txUrl } from "@/lib/chain/hashscan";
import { asset, payNetwork } from "./asset";

/**
 * CHAIN_MODE=stub payments. Same wire shapes as real x402 (402 + PAYMENT-REQUIRED, then a receipt
 * + PAYMENT-RESPONSE), but "paying" is just sending this header with the payer's account id.
 * gate() only routes here in stub mode; in testnet mode this header is ignored.
 */
export const STUB_PAYMENT_HEADER = "x-siege-stub-payment";

export const STUB_PAY_TO = "0.0.stub-treasury";
export const STUB_FEE_PAYER = "0.0.stub-facilitator";

let n = 0;

export function stubPaymentRequired(castle: Pick<Castle, "fee">, url: string, description: string, error?: string): PaymentRequired {
  return {
    x402Version: 2,
    ...(error ? { error } : {}),
    resource: { url, description, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network: payNetwork(),
        asset: asset().id,
        amount: castle.fee,
        payTo: STUB_PAY_TO,
        maxTimeoutSeconds: 180,
        extra: { feePayer: STUB_FEE_PAYER },
      },
    ],
  };
}

export async function stubGate(req: Request, p: { castle: Castle; description: string }): Promise<GateResult> {
  const payer = req.headers.get(STUB_PAYMENT_HEADER)?.trim();
  if (!payer) {
    const body = stubPaymentRequired(p.castle, req.url, p.description);
    return {
      ok: false,
      status: 402,
      body,
      headers: { "PAYMENT-REQUIRED": encodePaymentRequiredHeader(body), "cache-control": "no-store" },
    };
  }
  const txId = `stub:x402@${Date.now()}.${++n}`;
  const network = payNetwork();
  return {
    ok: true,
    receipt: {
      free: false,
      txId,
      payer: payer.slice(0, 80),
      amount: p.castle.fee,
      asset: asset().id,
      network,
      hashscanUrl: txUrl(txId),
      stub: true,
    },
    headers: {
      "PAYMENT-RESPONSE": encodePaymentResponseHeader({ success: true, transaction: txId, network, payer: payer.slice(0, 80) }),
    },
  };
}
