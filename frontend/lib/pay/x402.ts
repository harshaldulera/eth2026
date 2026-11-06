import type { x402ResourceServer } from "@x402/core/server";
import { env } from "@/lib/config/env";
import { payNetwork } from "./asset";

/**
 * Lazy, process-wide x402 resource server (testnet mode only).
 *
 * `initialize()` fetches the facilitator's /supported kinds once; the promise is cached and
 * cleared on failure so the next request retries instead of being stuck on a dead facilitator.
 */

/** The slice of x402ResourceServer the gate uses (lets tests inject a fake). */
export type GateServer = Pick<
  x402ResourceServer,
  "buildPaymentRequirements" | "createPaymentRequiredResponse" | "findMatchingRequirements" | "verifyPayment" | "settlePayment"
>;

type Holder = { key: string; ready: Promise<GateServer> };

const g = globalThis as unknown as { __siegeX402?: Holder; __siegeX402Override?: GateServer | null };

export async function resourceServer(): Promise<GateServer> {
  if (g.__siegeX402Override) return g.__siegeX402Override;
  const key = `${env().FACILITATOR_URL}|${payNetwork()}`;
  if (g.__siegeX402 && g.__siegeX402.key === key) return g.__siegeX402.ready;

  const ready = (async () => {
    const [{ x402ResourceServer, HTTPFacilitatorClient }, { ExactHederaScheme }] = await Promise.all([
      import("@x402/core/server"),
      import("@x402/hedera/exact/server"),
    ]);
    const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: env().FACILITATOR_URL, timeoutMs: 45_000 }));
    server.register(payNetwork(), new ExactHederaScheme());
    await server.initialize();
    return server as GateServer;
  })();
  const holder: Holder = { key, ready };
  g.__siegeX402 = holder;
  ready.catch(() => {
    if (g.__siegeX402 === holder) g.__siegeX402 = undefined;
  });
  return ready;
}

/** Tests only: replace the singleton with a fake (null restores the real one). */
export function __setX402ServerForTests(server: GateServer | null) {
  g.__siegeX402Override = server;
  g.__siegeX402 = undefined;
}
