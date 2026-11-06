import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import type { Amount } from "@/lib/types";
import { isStub } from "@/lib/config/env";
import { asset, payNetwork } from "./asset";
import { STUB_PAYMENT_HEADER } from "./stub";

export type PayerCreds = { accountId: string; privateKey?: string; perPaymentCap: Amount };

/** Thrown (stub) / mirrored from the x402 client (testnet) when a 402 asks for more than the cap. */
export class SpendControlError extends Error {
  constructor(
    readonly requested: string,
    readonly cap: string,
  ) {
    super(`spend control: payment exceeds cap (${requested} > ${cap})`);
    this.name = "SpendControlError";
  }
}

/**
 * True when a payer fetch refused to sign because the 402 asked for more than its cap: our stub
 * SpendControlError, or the real x402 client's "rejected by spendControls…" error. No money moved.
 */
export function isSpendControlRefusal(e: unknown): boolean {
  if (e instanceof SpendControlError) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /spendControls|spend control/i.test(msg);
}

/**
 * A fetch that pays x402 402s from `creds.accountId`, never more than `perPaymentCap` per payment.
 *
 * Testnet: the real x402 client (ExactHederaScheme + Hedera signer) with spend controls that opt
 * the asset in and cap it, so the library itself refuses an oversized payment.
 * Stub: call once, expect 402, check the asked amount against the cap, retry with the stub header.
 */
export function createPayerFetch(creds: PayerCreds, baseFetch: typeof fetch = fetch): typeof fetch {
  if (isStub()) return stubPayerFetch(creds, baseFetch);
  return lazyRealPayerFetch(creds, baseFetch);
}

function lazyRealPayerFetch(creds: PayerCreds, baseFetch: typeof fetch): typeof fetch {
  let wrapped: Promise<typeof fetch> | null = null;
  const build = async (): Promise<typeof fetch> => {
    if (!creds.privateKey) throw new Error(`No private key for payer ${creds.accountId}: cannot sign x402 payments`);
    const [{ x402Client }, { wrapFetchWithPayment }, { ExactHederaScheme }, { createClientHederaSigner }, { parsePrivateKey }] =
      await Promise.all([
        import("@x402/core/client"),
        import("@x402/fetch"),
        import("@x402/hedera/exact/client"),
        import("@x402/hedera"),
        import("./hedera"),
      ]);
    const network = payNetwork();
    const signer = createClientHederaSigner(creds.accountId, await parsePrivateKey(creds.privateKey), { network });
    const client = new x402Client().register(network, new ExactHederaScheme(signer));
    client.setSpendControls({
      allowedAssets: [{ network, asset: asset().id, maxAmountPerPayment: creds.perPaymentCap }],
    });
    return wrapFetchWithPayment(baseFetch, client) as typeof fetch;
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!wrapped) {
      wrapped = build();
      wrapped.catch(() => (wrapped = null));
    }
    return (await wrapped)(input, init);
  }) as typeof fetch;
}

async function readPaymentRequired(res: Response): Promise<PaymentRequired | null> {
  const h = res.headers.get("payment-required");
  if (h) {
    try {
      return decodePaymentRequiredHeader(h);
    } catch {
      /* fall through to the body */
    }
  }
  try {
    const body = (await res.clone().json()) as PaymentRequired;
    return Array.isArray(body?.accepts) ? body : null;
  } catch {
    return null;
  }
}

function pick(pr: PaymentRequired): PaymentRequirements | undefined {
  const a = asset().id;
  const net = payNetwork();
  return pr.accepts.find((r) => r.network === net && r.asset === a) ?? pr.accepts[0];
}

function stubPayerFetch(creds: PayerCreds, baseFetch: typeof fetch): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const isReq = typeof Request !== "undefined" && input instanceof Request;
    const first = await baseFetch(isReq ? (input as Request).clone() : input, init);
    if (first.status !== 402) return first;

    const pr = await readPaymentRequired(first);
    const req = pr ? pick(pr) : undefined;
    if (!req) throw new Error("x402: 402 response carried no usable payment requirements");
    if (BigInt(req.amount) > BigInt(creds.perPaymentCap)) throw new SpendControlError(req.amount, creds.perPaymentCap);

    const headers = new Headers(init?.headers ?? (isReq ? (input as Request).headers : undefined));
    headers.set(STUB_PAYMENT_HEADER, creds.accountId);
    if (isReq) return baseFetch(new Request(input as Request, { ...init, headers }));
    return baseFetch(input, { ...init, headers });
  }) as typeof fetch;
}
