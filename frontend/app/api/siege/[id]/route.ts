import { getCastle } from "@/lib/castles";
import { getSiege } from "@/lib/siege";
import { atRequestTime, err, json } from "../../_lib/http";

/** GET /api/siege/[id] — the siege (transcript, receipt, chain txs) and its castle. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await atRequestTime();
  const { id } = await ctx.params;
  const s = getSiege(id);
  if (!s) return err(404, "siege_not_found");
  const castle = getCastle(s.castleId);
  if (!castle) return err(404, "castle_not_found");
  return json({ siege: s, castle });
}
