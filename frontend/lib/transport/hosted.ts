// STUB — Lane B replaces with the hosted 0G guardian transport (prompt assembly + 0G call through the vault's proxy key); keep the signature.
import { castleRow } from "@/lib/castles";
import { guardian } from "@/lib/guardian";
import { proxy } from "@/lib/proxy";
import { lastRaiderTurn, type SiegeTransport } from "./types";

/**
 * Hosted guardians: our own runtime (lib/guardian). Every call
 *  1. takes the vault-scoped model key from the proxy (never the team key),
 *  2. asks the guardian,
 *  3. writes the proxy request record (hashes only) — in the real proxy this happens on the request
 *     path itself; the stub writes it right after the decision,
 *  4. returns the decision with `requestId` = the proxy record's id (the guardian's own id is kept in
 *     `raw.upstreamRequestId`).
 * The vault id is the castle id.
 */
export const hostedTransport: SiegeTransport = {
  kind: "hosted",

  async respond(castleId, siegeMessages, ctx) {
    const row = castleRow(castleId);
    if (!row) throw new Error(`transport(hosted): castle ${castleId} not found`);
    const via = await proxy.issueKey(castleId);
    const decision = await guardian.respond(castleId, siegeMessages, via);
    const rec = await proxy.recordRequest({
      vaultId: castleId,
      siegeId: ctx?.siegeId,
      turn: ctx?.turn ?? lastRaiderTurn(siegeMessages),
      // Stub prompt = the orders; Lane B's prompt assembly adds the tier preset and tool contract.
      systemPrompt: row.orders,
      toolCalls: decision.toolCalls,
      protectedTool: row.protectedTool,
    });
    const raw = decision.raw && typeof decision.raw === "object" ? (decision.raw as Record<string, unknown>) : { value: decision.raw };
    return { ...decision, requestId: rec.requestId, raw: { ...raw, transport: "hosted", upstreamRequestId: decision.requestId } };
  },

  async status(castleId) {
    const row = castleRow(castleId);
    if (!row) throw new Error(`transport(hosted): castle ${castleId} not found`);
    return row.vaultState;
  },
};
