import { z } from "zod";
import { castleRow, getCastle } from "@/lib/castles";
import { closeCastle } from "@/lib/vault";
import { revokeZg } from "@/lib/zg/connect";
import { err, isOwnerOf, json, readBody } from "../../../_lib/http";

/**
 * POST /api/castles/[id]/close { reason } — close a castle's vault (owner cookie, same auth as approvals).
 *   owner_closed    the Castellan's choice, any time
 *   orders_changed  the auto-close path (Lane B raises it when the guardian's prompt hash changes)
 *   expired         only once the deadline has passed (the worker also does this by itself)
 * SiegeVault.closeVault returns the pot to the castellan; every in-flight paid siege is voided and its
 * fee refunded by the worker; the vault state goes "closed" (HCS "vault.state").
 * -> { ok, tx, refunded, inFlightRefunds }
 */

const Body = z.object({ reason: z.enum(["owner_closed", "orders_changed", "expired"]) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isOwnerOf(req, id)) return err(401, "owner_key_required");
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;
  const castle = getCastle(id);
  if (!castle) return err(404, "castle_not_found");
  const r = await closeCastle(id, body.data.reason);
  if (!r.ok) return err(r.status, r.reason, r.reason === "not_expired" ? { deadline: castle.deadline } : {});
  // The guard's 0G key was minted for this vault only: revoke it (best effort, never throws).
  const keys = castleRow(id);
  if (keys?.zgMgmtKey && keys.zgKeyId) await revokeZg({ mgmtKey: keys.zgMgmtKey, keyId: keys.zgKeyId });
  return json({ ok: true, tx: r.tx, refunded: r.refunded, inFlightRefunds: r.inFlightRefunds, castle: getCastle(id) });
}
