import { getCastle } from "@/lib/castles";
import { fundVault } from "@/lib/vault";
import { isStub } from "@/lib/config/env";
import { err, isOwner, isOwnerOf, json } from "../../../_lib/http";

/**
 * POST /api/castles/[id]/open — the Bring-your-agent "Open" button (plan C3), production path.
 * The arena owner (OWNER_SECRET cookie) only: the pot is the ARENA's money with no deposit behind it.
 * A castle's own ok_ key may use it only in stub mode (no real HBAR); on testnet a published vault is
 * funded by its owner's deposit (POST /api/castles/[id]/fund), so an ok_ key gets 409 fund_by_deposit.
 * The castle must be "verified" (its guardian passed its
 * checks; an SDK harness its smoke siege): SiegeVault.createVault(fee, duration, castellan,
 * protectedTool) with the castle's pot, then verified -> funded (HCS "vault.state"). Lane B then moves
 * funded -> guarding when the guardian is live; only guarding castles take sieges.
 * -> 200 { ok, vaultId, tx, reason, castle }
 *  | 401 owner_key_required | 409 fund_by_deposit | 404 castle_not_found | 409 { error: "not_verified", vaultState } | 502 { error }
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isOwner(req)) {
    if (!isOwnerOf(req, id)) return err(401, "owner_key_required");
    if (!isStub()) return err(409, "fund_by_deposit", { message: "Fund this vault with a deposit from its owner wallet (POST /api/castles/<id>/fund)." });
  }
  const castle = getCastle(id);
  if (!castle) return err(404, "castle_not_found");
  if (castle.vaultState !== "verified") return err(409, "not_verified", { vaultState: castle.vaultState, message: "Only a verified vault can be opened." });
  const r = await fundVault(id);
  if (!r.ok) {
    if (r.reason === "not_found") return err(404, "castle_not_found");
    if (r.reason === "illegal_transition") return err(409, "not_verified", { vaultState: getCastle(id)?.vaultState });
    if (r.reason === "fund_in_progress") return err(409, "fund_in_progress", { message: "This vault is already being funded." });
    return err(502, r.reason);
  }
  return json({ ok: true, vaultId: r.vaultId, tx: r.tx, reason: r.reason, castle: getCastle(id) });
}
