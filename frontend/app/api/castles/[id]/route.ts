import { castleRow, getCastle } from "@/lib/castles";
import { publicProgram } from "@/lib/transport";
import { auditTrail } from "@/lib/chain";
import { listSieges } from "@/lib/siege";
import { atRequestTime, err, json } from "../../_lib/http";

/** GET /api/castles/[id] — castle, its 20 most recent sieges, its HCS audit trail and its public program brief. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await atRequestTime();
  const { id } = await ctx.params;
  const castle = getCastle(id);
  if (!castle) return err(404, "castle_not_found");
  const row = castleRow(id);
  return json({ castle, sieges: listSieges({ castleId: id, limit: 20 }), audit: auditTrail(id), ...(row ? { program: publicProgram(row) } : {}) });
}
