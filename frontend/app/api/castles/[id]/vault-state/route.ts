import { z } from "zod";
import { isStub } from "@/lib/config/env";
import { getCastle } from "@/lib/castles";
import { closeCastle, fundVault, transitionVault } from "@/lib/vault";
import { err, isOwner, isOwnerOf, json, readBody } from "../../../_lib/http";

/**
 * POST /api/castles/[id]/vault-state { to, reason } — DEV / STUB ONLY. Lets the demo (and Lane B, before
 * the real @siege/guard SDK exists) walk a vault through its lifecycle by hand. Owner cookie required.
 * Refused in testnet mode unless SIEGE_DEV_ENDPOINTS=1.
 *   connected | verified | guarding | dormant   plain transitions (dormant refunds in-flight sieges)
 *   funded                                       SiegeVault.createVault with the castle's protectedTool
 *   closed                                       same as POST /api/castles/[id]/close (reason: owner_closed | orders_changed | expired)
 *   created | broken                             refused: a vault never goes back, and only a verified payout breaks it
 * -> { ok, castle, change? , vaultId?, tx? } | 409 { error: "illegal_transition" }
 */

const Body = z.object({
  to: z.enum(["created", "connected", "verified", "funded", "guarding", "dormant", "broken", "closed"]),
  reason: z.string().trim().min(1).max(200).optional(),
});

const devEndpointsOn = () => isStub() || process.env.SIEGE_DEV_ENDPOINTS === "1";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!devEndpointsOn()) return err(404, "dev_endpoint_disabled", { message: "Set SIEGE_DEV_ENDPOINTS=1 to use this outside stub mode." });
  const { id } = await ctx.params;
  if (!isOwnerOf(req, id)) return err(401, "owner_key_required");
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;
  if (!getCastle(id)) return err(404, "castle_not_found");
  const { to } = body.data;
  const reason = body.data.reason ?? `dev: ${to}`;

  if (to === "created" || to === "broken") return err(409, "illegal_transition", { message: `"${to}" cannot be set by hand.` });
  if (to === "funded") {
    // The pot is the arena's money: same rule as POST /open (arena owner, or a castle's ok_ key in stub only).
    if (!isOwner(req) && !isStub()) return err(409, "fund_by_deposit", { message: "Fund this vault with a deposit from its owner wallet." });
    const r = await fundVault(id);
    if (!r.ok) return err(r.reason === "not_found" ? 404 : r.reason === "illegal_transition" ? 409 : 502, r.reason);
    return json({ ok: true, vaultId: r.vaultId, tx: r.tx, reason: r.reason, castle: getCastle(id) });
  }
  if (to === "closed") {
    const why = body.data.reason;
    const closeReason = why === "orders_changed" || why === "expired" ? why : "owner_closed";
    const r = await closeCastle(id, closeReason);
    if (!r.ok) return err(r.status, r.reason);
    return json({ ok: true, tx: r.tx, refunded: r.refunded, inFlightRefunds: r.inFlightRefunds, castle: getCastle(id) });
  }
  const r = await transitionVault(id, to, reason);
  if (!r.ok) return err(r.reason === "not_found" ? 404 : 409, r.reason);
  return json({ ok: true, change: r.change, castle: getCastle(id) });
}
