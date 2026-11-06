import { listCastles } from "@/lib/castles";
import type { CastleFilter, CastleStatus, Tier } from "@/lib/types";
import { atRequestTime, json } from "../_lib/http";

const TIERS: Tier[] = ["wooden", "stone", "iron"];
const STATUSES: CastleStatus[] = ["open", "broken", "closed"];
const SORTS: NonNullable<CastleFilter["sort"]>[] = ["pot", "streak", "fee", "recent"];

/** GET /api/castles?tier=&status=&minPot=&sort= — never includes guardian orders. */
export async function GET(req: Request) {
  await atRequestTime();
  const q = new URL(req.url).searchParams;
  const filter: CastleFilter = {};
  const tier = q.get("tier") as Tier | null;
  const status = q.get("status") as CastleStatus | null;
  const sort = q.get("sort") as CastleFilter["sort"] | null;
  if (tier && TIERS.includes(tier)) filter.tier = tier;
  if (status && STATUSES.includes(status)) filter.status = status;
  if (sort && SORTS.includes(sort)) filter.sort = sort;
  const minPot = q.get("minPot");
  if (minPot && /^\d+$/.test(minPot)) filter.minPot = minPot;
  return json({ castles: listCastles(filter) });
}
