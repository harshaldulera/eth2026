import { getCastle } from "@/lib/castles";
import { auditTrail } from "@/lib/chain";
import { listSieges } from "@/lib/siege";
import { atRequestTime, err, json } from "../../_lib/http";

/** GET /api/castles/[id] — castle, its 20 most recent sieges and its HCS audit trail. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await atRequestTime();
  const { id } = await ctx.params;
  const castle = getCastle(id);
  if (!castle) return err(404, "castle_not_found");
  return json({ castle, sieges: listSieges({ castleId: id, limit: 20 }), audit: auditTrail(id) });
}
