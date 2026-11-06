import { buildReplay } from "@/lib/replay/build";
import { atRequestTime, err, json } from "../../_lib/http";

/**
 * GET /api/replay/[id] — a siege turn by turn with every check recomputed: the transcript from Swarm
 * against its stored hash, the hash on the castle's HCS topic, each raider message against its HCS
 * hash, each guardian reply's inference record, the verifier's verdict and the payout tx. Public.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await atRequestTime();
  const { id } = await ctx.params;
  const replay = await buildReplay(id);
  if (!replay) return err(404, "siege_not_found");
  return json(replay);
}
