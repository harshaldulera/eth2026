import { listCastles } from "@/lib/castles";
import { db, schema } from "@/lib/db";
import type { CastleFilter, CastleStatus, Tier, TransportKind, VaultState } from "@/lib/types";
import { atRequestTime, json } from "../_lib/http";

const TIERS: Tier[] = ["wooden", "stone", "iron"];
const STATUSES: CastleStatus[] = ["open", "broken", "closed"];
const SORTS: NonNullable<CastleFilter["sort"]>[] = ["pot", "streak", "fee", "recent"];
const VAULT_STATES: VaultState[] = ["created", "connected", "verified", "funded", "guarding", "dormant", "broken", "closed"];
const TRANSPORTS: TransportKind[] = ["hosted", "sdk"];

/**
 * GET /api/castles?tier=&status=&vaultState=&transport=&minPot=&sort= — never includes guardian orders.
 * Without a vaultState filter it returns every castle (each carries vaultState / transport / protectedTool);
 * the board shows only vaultState "guarding" (the only state that takes sieges).
 */
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
  const vaultState = q.get("vaultState") as VaultState | null;
  const transport = q.get("transport") as TransportKind | null;
  if (vaultState && VAULT_STATES.includes(vaultState)) filter.vaultState = vaultState;
  if (transport && TRANSPORTS.includes(transport)) filter.transport = transport;
  const minPot = q.get("minPot");
  if (minPot && /^\d+$/.test(minPot)) filter.minPot = minPot;
  let castles = listCastles(filter);
  // Applied here too (from the DB), so the filter holds whatever listCastles supports.
  if (filter.vaultState || filter.transport) {
    const rows = db().select({ id: schema.castles.id, vaultState: schema.castles.vaultState, transport: schema.castles.transport }).from(schema.castles).all();
    const by = new Map(rows.map((r) => [r.id, r]));
    castles = castles.filter((c) => {
      const r = by.get(c.id);
      return (!filter.vaultState || r?.vaultState === filter.vaultState) && (!filter.transport || r?.transport === filter.transport);
    });
  }
  return json({ castles });
}
