// STUB — Lane B replaces the transports behind these exports (hosted 0G guardian, @siege/guard relay); keep the signatures.
import type { TransportKind } from "@/lib/types";
import { hostedTransport } from "./hosted";
import { sdkTransport } from "./sdk";
import type { SiegeTransport } from "./types";

/**
 * The one seam between the siege engine and any guardian (plan: "Two decisions that cannot be
 * deferred"). lib/siege imports ONLY this module for guardian replies; only lib/transport/** may
 * import @/lib/guardian (eslint no-restricted-imports).
 */

const BY_KIND: Record<TransportKind, SiegeTransport> = { hosted: hostedTransport, sdk: sdkTransport };

/** The transport for a castle (or a siege: its transport is fixed at start). */
export function transportFor(x: { transport: TransportKind } | TransportKind): SiegeTransport {
  const kind = typeof x === "string" ? x : x.transport;
  const t = BY_KIND[kind];
  if (!t) throw new Error(`transport: unknown kind ${String(kind)}`);
  return t;
}

export const transport = {
  hosted: hostedTransport,
  sdk: sdkTransport,
  for: transportFor,
} as const;

export { hostedTransport, sdkTransport };
export { REFUND_BOT_SYSTEM_PROMPT, refundBotDecide } from "./sdk";
export { lastRaiderTurn, TransportUnavailableError, type RespondContext, type SiegeTransport } from "./types";
