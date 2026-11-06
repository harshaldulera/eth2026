import type { Castle } from "@/lib/types";
import { toUnits } from "@/lib/money/format";
import { tierLevel } from "@/lib/vocab";
import type { BoardQuery } from "@/components/arena/board-filters";

/**
 * The Grid's sort chips. Four are the design's (EASIEST · BIGGEST POT · QUIET · LONGEST STREAK);
 * the Arkiv board's own sorts (fee, newest) stay as chips too. `server` orders map onto the Arkiv
 * query's `sort` (BoardQuery.sort), the others reorder on the client.
 */
export type GridOrder = "easiest" | "pot" | "quiet" | "streak" | "fee" | "recent";

export const ORDERS: { v: GridOrder; label: string; title: string }[] = [
  { v: "easiest", label: "EASIEST", title: "Lowest tier first, then the biggest pot" },
  { v: "pot", label: "BIGGEST POT", title: "Biggest pot first (Arkiv sort)" },
  { v: "quiet", label: "QUIET", title: "No live op, fewest ops run" },
  { v: "streak", label: "LONGEST STREAK", title: "Longest held streak first (Arkiv sort)" },
  { v: "fee", label: "CHEAPEST FEE", title: "Cheapest op fee first (Arkiv sort)" },
  { v: "recent", label: "NEWEST", title: "Newest vault first (Arkiv sort)" },
];

/** URL → order: the Arkiv `sort` wins when set, else `?order=pot|quiet`, else EASIEST. */
export function orderFrom(q: BoardQuery, p: URLSearchParams): GridOrder {
  if (q.sort === "streak" || q.sort === "fee" || q.sort === "recent") return q.sort;
  const o = p.get("order");
  return o === "pot" || o === "quiet" ? o : "easiest";
}

/** Order → the Arkiv query's sort + the client `order` param. */
export function applyOrder(q: BoardQuery, order: GridOrder): { query: BoardQuery; orderParam: string | null } {
  if (order === "streak" || order === "fee" || order === "recent") return { query: { ...q, sort: order }, orderParam: null };
  return { query: { ...q, sort: undefined }, orderParam: order === "easiest" ? null : order };
}

const pot = (c: Castle) => toUnits(c.pot);
const cmpBig = (a: bigint, b: bigint) => (a === b ? 0 : a > b ? -1 : 1);

/** Sorted copy. `live` = castle ids with an op running right now. */
export function sortCastles<T extends Castle>(castles: readonly T[], order: GridOrder, live: ReadonlySet<string> = new Set()): T[] {
  const out = [...castles];
  switch (order) {
    case "easiest":
      return out.sort((a, b) => tierLevel(a.tier, a.transport) - tierLevel(b.tier, b.transport) || cmpBig(pot(a), pot(b)));
    case "pot":
      return out.sort((a, b) => cmpBig(pot(a), pot(b)));
    case "quiet":
      return out.sort(
        (a, b) => Number(live.has(a.id)) - Number(live.has(b.id)) || (a.siegeCount ?? 0) - (b.siegeCount ?? 0) || tierLevel(a.tier, a.transport) - tierLevel(b.tier, b.transport),
      );
    case "streak":
      return out.sort((a, b) => b.streak - a.streak);
    case "fee":
      return out.sort((a, b) => -cmpBig(toUnits(a.fee), toUnits(b.fee)));
    case "recent":
      return out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
}
