import { arkivLinks, isArkivLive } from "@/lib/arkiv";
import { castleOnArkiv } from "@/lib/arkiv/inspect";
import { atRequestTime, err, json } from "../../../_lib/http";

/**
 * GET /api/arkiv/vault/[id] — a vault's two Arkiv entities: the Owner-owned listing (owner read
 * from the chain), the arena-owned status, explorer links, expiry, and whether it was delisted.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await atRequestTime();
  const { id } = await ctx.params;
  if (!isArkivLive()) return json({ live: false, vaultId: id });
  const r = await castleOnArkiv(id);
  if (!r) return err(404, "not_on_arkiv");
  return json({
    live: true,
    vaultId: id,
    listing: r.listing && { key: r.listing.key, owner: r.listing.owner, readonly: r.listing.readonly, expiresAtMs: r.listing.expiresAtMs, url: arkivLinks.entity(r.listing.key) },
    state: r.state && { key: r.state.key, expiresAtMs: r.state.expiresAtMs, url: arkivLinks.entity(r.state.key) },
    ownerWallet: r.ownerWallet,
    ownerWalletUrl: arkivLinks.address(r.ownerWallet),
    delisted: r.delisted,
    block: r.block,
  });
}
