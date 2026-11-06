import { castleRow } from "@/lib/castles";
import { guardian } from "@/lib/guardian";
import type { SiegeTransport } from "./types";

/**
 * Hosted guardians: our own runtime (lib/guardian). The 0G guardian reaches the model only through
 * lib/proxy with the castle's vault-scoped key, and the proxy writes the request record the verifier
 * reads. The stub guardian (GUARDIAN_MODE=stub) answers locally with "0g-stub-…" request ids.
 */
export const hostedTransport: SiegeTransport = {
  kind: "hosted",

  respond(castleId, siegeMessages, ctx) {
    return guardian.respond(castleId, siegeMessages, ctx);
  },

  async status(castleId) {
    const row = castleRow(castleId);
    if (!row) throw new Error(`transport(hosted): castle ${castleId} not found`);
    return row.vaultState;
  },
};
