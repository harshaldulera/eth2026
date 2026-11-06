import { getCastle } from "@/lib/castles";
import { fundVault } from "@/lib/vault";
import { err, isOwner, json } from "../../../_lib/http";

/**
 * POST /api/castles/[id]/open — the Bring-your-agent "Open" button (plan C3), production path.
 * Owner cookie (same auth as close / approvals). The castle must be "verified" (its guardian passed its
 * checks; an SDK harness its smoke siege): SiegeVault.createVault(fee, duration, castellan,
 * protectedTool) with the castle's pot, then verified -> funded (HCS "vault.state"). Lane B then moves
 * funded -> guarding when the guardian is live; only guarding castles take sieges.
 * -> 200 { ok, vaultId, tx, reason, castle }
 *  | 401 owner_key_required | 404 castle_not_found | 409 { error: "not_verified", vaultState } | 502 { error }
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isOwner(req)) return err(401, "owner_key_required");
  const { id } = await ctx.params;
  const castle = getCastle(id);
  if (!castle) return err(404, "castle_not_found");
  if (castle.vaultState !== "verified") return err(409, "not_verified", { vaultState: castle.vaultState, message: "Only a verified vault can be opened." });
  const r = await fundVault(id);
  if (!r.ok) {
    if (r.reason === "not_found") return err(404, "castle_not_found");
    if (r.reason === "illegal_transition") return err(409, "not_verified", { vaultState: getCastle(id)?.vaultState });
    return err(502, r.reason);
  }
  return json({ ok: true, vaultId: r.vaultId, tx: r.tx, reason: r.reason, castle: getCastle(id) });
}
