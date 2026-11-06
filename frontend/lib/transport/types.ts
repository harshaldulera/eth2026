import type { GuardianRespondContext, GuardianTransport, SiegeMessage, TransportKind } from "@/lib/types";

/**
 * Where a guardian reply is being asked for. The proxy tags the request record with these, and the
 * verifier later requires the final reply's record to carry this siege and turn.
 * (Now part of GuardianTransport in lib/types; kept as aliases for existing imports.)
 */
export type RespondContext = GuardianRespondContext;

export type SiegeTransport = GuardianTransport;

/** The transport could not reach the guardian (e.g. an SDK harness that is dormant). The turn is not used. */
export class TransportUnavailableError extends Error {
  readonly code = "transport_unavailable";
  constructor(
    readonly kind: TransportKind,
    readonly castleId: string,
    readonly detail: string,
  ) {
    super(`${kind} transport: guardian for ${castleId} unavailable (${detail})`);
    this.name = "TransportUnavailableError";
  }
}

/** Turn of the last raider message (1 when there is none). */
export function lastRaiderTurn(messages: SiegeMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "raider") return messages[i].turn;
  return 1;
}
