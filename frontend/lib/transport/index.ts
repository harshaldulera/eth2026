/**
 * GuardianTransport seam (plan Checkpoint 0, "Two decisions that cannot be deferred"). lib/siege calls
 * guardians ONLY through this module, so the engine never knows whether a guardian is hosted or an
 * external harness. Only lib/transport/** may import @/lib/guardian (eslint no-restricted-imports).
 */
import { castleRow } from "@/lib/castles";
import type { TransportKind } from "@/lib/types";
import { hostedTransport } from "./hosted";
import { sdkTransport } from "./sdk";
import type { SiegeTransport } from "./types";

const BY_KIND: Record<TransportKind, SiegeTransport> = { hosted: hostedTransport, sdk: sdkTransport };

/**
 * The transport for a castle id, a castle/siege row (its transport is fixed at start) or a kind.
 * Unknown castles fall back to hosted so callers get the castle-not-found error from the guardian.
 */
export function transportFor(x: string | { transport: TransportKind }): SiegeTransport {
  if (typeof x !== "string") return BY_KIND[x.transport] ?? hostedTransport;
  if (x === "hosted" || x === "sdk") return BY_KIND[x];
  const kind = castleRow(x)?.transport;
  return kind ? BY_KIND[kind] : hostedTransport;
}

export const transport = { hosted: hostedTransport, sdk: sdkTransport, for: transportFor } as const;

export { hostedTransport, sdkTransport };
export { REFUND_BOT_SYSTEM_PROMPT, refundBotDecide } from "./sdk";
export { lastRaiderTurn, TransportUnavailableError, type RespondContext, type SiegeTransport } from "./types";

/** What the verifier needs from the hosted runtime, without lib/siege importing lib/guardian. */
export { guardianMode, PROTECTED_TOOL, systemPrompt } from "@/lib/guardian";
