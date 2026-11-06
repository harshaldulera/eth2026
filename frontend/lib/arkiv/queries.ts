/**
 * Live reads from Arkiv. The Grid reads `vaultStatus` (arena-owned); every query filters
 * `.ownedBy(...)`, so only entities the arena wrote count. Each result carries the block it was
 * read at: the board prints it as proof the data came from the chain, not from our database.
 */
import { and, eq, gte, type Expression } from "@arkiv-network/sdk/query";
import { asc, desc } from "@arkiv-network/sdk/query";
import { u64 } from "@arkiv-network/sdk/schema";
import type { CastleFilter, Profile, Siege } from "@/lib/types";
import { arenaAddress, arkivReader } from "./client";
import { TIER_NUMBER, VAULT_LIFECYCLE, VAULT_OUTCOME, rowToCastle, rowToProfile, rowToSiege, type CastleOnArkiv, type Row } from "./codec";
import { schemas } from "./schema";

export type Read<T> = { data: T; block: bigint };

type Fetchable = { fetch(): Promise<{ entities: readonly Row[]; blockNumber: bigint }> };
type Builder = Fetchable & {
  where(e: Expression): Builder;
  ownedBy(a: string): Builder;
  orderBy(o: unknown): Builder;
  limit(n: number): Builder;
};
/** The typed builder fights dynamic filters; this keeps the call sites readable. */
const from = (kind: keyof ReturnType<typeof schemas>): Builder =>
  (arkivReader() as unknown as { select(): { from(s: unknown): Builder } }).select().from(schemas()[kind]).ownedBy(arenaAddress());

/** Human-readable form of the board query, for the query bar and the README. */
export function describeCastleQuery(f: CastleFilter = {}, opts: { allStates?: boolean } = {}): string {
  const parts: string[] = [];
  if (f.tier) parts.push(`tier = ${TIER_NUMBER[f.tier]}`);
  if (f.status) parts.push(`status = "${VAULT_OUTCOME[f.status]}"`);
  if (f.vaultState || !opts.allStates) parts.push(`vaultState = "${VAULT_LIFECYCLE[f.vaultState ?? "guarding"]}"`);
  if (f.transport) parts.push(`transport = "${f.transport}"`);
  if (f.minPot) parts.push(`pot >= ${f.minPot}`);
  const order = f.sort === "streak" ? "streak DESC" : f.sort === "fee" ? "fee ASC" : f.sort === "recent" ? "createdAtMs DESC" : "pot DESC";
  return `vaultStatus${parts.length ? ` WHERE ${parts.join(" AND ")}` : ""} ORDER BY ${order}`;
}

/** Block height → unix ms, assuming 2-second blocks from the block the query was answered at. */
const blockToMs = (target: bigint, at: bigint, now: number) => now + Number(target - at) * 2000;

/**
 * The Grid's query. With no vaultState it lists guarding vaults only (the only state that takes ops),
 * unless `allStates` asks for every castle the arena publishes.
 */
export async function listCastlesLive(f: CastleFilter = {}, opts: { allStates?: boolean } = {}): Promise<Read<CastleOnArkiv[]>> {
  const conds: Expression[] = [];
  if (f.vaultState || !opts.allStates) conds.push(eq("vaultState", VAULT_LIFECYCLE[f.vaultState ?? "guarding"]));
  if (f.tier) conds.push(eq("tier", u64(TIER_NUMBER[f.tier])));
  if (f.status) conds.push(eq("status", VAULT_OUTCOME[f.status]));
  if (f.transport) conds.push(eq("transport", f.transport));
  if (f.minPot && /^\d+$/.test(f.minPot)) conds.push(gte("pot", u64(BigInt(f.minPot))));
  const order =
    f.sort === "streak" ? desc("streak") : f.sort === "fee" ? asc("fee") : f.sort === "recent" ? desc("createdAtMs") : desc("pot");
  const q = from("vaultStatus");
  const res = await (conds.length ? q.where(conds.length === 1 ? conds[0] : and(...conds)) : q).orderBy(order).limit(100).fetch();
  const now = Date.now();
  const data = res.entities.map((r) => {
    const c = rowToCastle(r);
    if (typeof r.$expiresAt === "bigint") c.arkiv.expiresAtMs = blockToMs(r.$expiresAt, res.blockNumber, now);
    return c;
  });
  return { data, block: res.blockNumber };
}

export async function liveSiegesLive(): Promise<Read<Siege[]>> {
  const res = await from("op").where(eq("status", "live")).limit(100).fetch();
  return { data: res.entities.map(rowToSiege), block: res.blockNumber };
}

export async function siegeLive(siegeId: string): Promise<Read<(Siege & { swarmRef?: string }) | null>> {
  const res = await from("op").where(eq("opId", siegeId)).limit(1).fetch();
  return { data: res.entities[0] ? rowToSiege(res.entities[0]) : null, block: res.blockNumber };
}

export async function profileLive(wallet: string): Promise<Read<Profile | null>> {
  const g = await from("guardProfile").where(eq("wallet", wallet)).limit(1).fetch();
  if (g.entities[0]) return { data: rowToProfile(g.entities[0], "guardian"), block: g.blockNumber };
  const r = await from("operatorProfile").where(eq("wallet", wallet)).limit(1).fetch();
  return { data: r.entities[0] ? rowToProfile(r.entities[0], "raider") : null, block: r.blockNumber };
}

/** Leaderboards (C5): top guardians by streak, top raiders by breaks. */
export async function topProfilesLive(kind: "guardian" | "raider", limit = 20): Promise<Read<Profile[]>> {
  const res =
    kind === "guardian"
      ? await from("guardProfile").orderBy(desc("streak")).limit(limit).fetch()
      : await from("operatorProfile").orderBy(desc("breaches")).limit(limit).fetch();
  return { data: res.entities.map((r) => rowToProfile(r, kind)), block: res.blockNumber };
}
