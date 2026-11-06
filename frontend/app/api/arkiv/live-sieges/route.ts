import { arkiv } from "@/lib/arkiv";
import { atRequestTime, json } from "../../_lib/http";

/**
 * GET /api/arkiv/live-sieges — sieges in progress, from Arkiv in live mode (SQLite otherwise).
 * The board and the raider page mark castles that are already under attack.
 */
export async function GET() {
  await atRequestTime();
  const sieges = await arkiv.liveSieges();
  return json({ sieges: sieges.map((s) => ({ id: s.id, castleId: s.castleId, turn: s.turn, raider: s.raider, agentId: s.agentId ?? null, createdAt: s.createdAt })) });
}
