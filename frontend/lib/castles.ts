import { and, desc, asc, eq, gte, isNull, lt, ne, type SQL } from "drizzle-orm";
import { db, schema, type DB } from "@/lib/db";
import { MAX_CHAIN_ATTEMPTS } from "@/lib/db/schema";
import { env } from "@/lib/config/env";
import type { Asset, Castle, CastleFilter } from "@/lib/types";

/**
 * Castle reads. `castleRow` returns the raw row INCLUDING secret orders (server only: guardian and
 * seed). Everything public goes through `toCastle`, which never includes orders.
 */

export type CastleRow = typeof schema.castles.$inferSelect;

/** Record-based guardian title. */
export function titleFor(streak: number): string {
  if (streak >= 200) return "Unbroken";
  if (streak >= 50) return "Iron Warden";
  if (streak >= 10) return "Warden";
  return "Recruit";
}

const KNOWN_ASSETS: Record<string, Asset> = {
  "0.0.0": { id: "0.0.0", decimals: 8, symbol: "HBAR" },
  "0.0.429274": { id: "0.0.429274", decimals: 6, symbol: "USDC" },
};

/** Asset for a castle's asset id; the configured X402 asset wins when ids match. */
export function assetFor(id: string): Asset {
  const e = env();
  if (id === e.X402_ASSET) return { id, decimals: e.X402_ASSET_DECIMALS, symbol: e.X402_ASSET_SYMBOL };
  return KNOWN_ASSETS[id] ?? { id, decimals: 0, symbol: id };
}

export function toCastle(row: CastleRow): Castle {
  const c: Castle = {
    id: row.id,
    name: row.name,
    guardianName: row.guardianName,
    title: titleFor(row.streak),
    personality: row.personality,
    tier: row.tier,
    pot: String(row.potTinybar),
    fee: String(row.feeTinybar),
    asset: assetFor(row.asset),
    streak: row.streak,
    siegeCount: row.siegeCount,
    status: row.status,
    owner: row.owner,
    vaultId: row.vaultId ?? null,
    topicId: row.topicId ?? null,
    protectedTool: row.protectedTool,
    vaultState: row.vaultState,
    transport: row.transport,
    deadline: row.deadline,
    createdAt: row.createdAt,
  };
  if (row.vaultStateReason) c.vaultStateReason = row.vaultStateReason;
  if (row.lastSeenAt) c.lastSeenAt = row.lastSeenAt;
  if (row.portraitUrl) c.portraitUrl = row.portraitUrl;
  return c;
}

/** Raw row incl. secret orders. Server only — never return this from a route. */
export function castleRow(id: string): CastleRow | null {
  return db().select().from(schema.castles).where(eq(schema.castles.id, id)).get() ?? null;
}

export function getCastle(id: string): Castle | null {
  const row = castleRow(id);
  return row ? toCastle(row) : null;
}

/**
 * Filter by tier/status/vaultState/transport/minPot. No vaultState filter = every state (castellan
 * pages, worker); the board passes vaultState "guarding" (lib/arkiv's listCastles does by default).
 * Sort: pot (desc, default), streak (desc), fee (asc: cheapest first), recent (createdAt desc).
 */
export function listCastles(filter: CastleFilter = {}): Castle[] {
  const c = schema.castles;
  const where: SQL[] = [];
  if (filter.tier) where.push(eq(c.tier, filter.tier));
  if (filter.status) where.push(eq(c.status, filter.status));
  if (filter.vaultState) where.push(eq(c.vaultState, filter.vaultState));
  if (filter.transport) where.push(eq(c.transport, filter.transport));
  if (filter.minPot !== undefined && filter.minPot !== "") {
    const min = Number(filter.minPot);
    if (Number.isFinite(min)) where.push(gte(c.potTinybar, min));
  }
  const order =
    filter.sort === "streak"
      ? [desc(c.streak), desc(c.potTinybar)]
      : filter.sort === "fee"
        ? [asc(c.feeTinybar), desc(c.potTinybar)]
        : filter.sort === "recent"
          ? [desc(c.createdAt), asc(c.id)]
          : [desc(c.potTinybar), asc(c.id)];
  return db()
    .select()
    .from(c)
    .where(where.length ? and(...where) : undefined)
    .orderBy(...order)
    .all()
    .map(toCastle);
}

/** A DB handle or a transaction handle (both can select). */
type Reader = Pick<DB, "select">;

export type CastleClosed = "not_found" | "broken" | "closed" | "expired" | "being_broken";

/**
 * Why a castle cannot take (or continue) a paid siege right now, or null when it can.
 * Beyond `status`, a castle is already won the moment a PAID siege on it ends broken — the worker
 * only flips `status` after the release lands on chain, seconds later. "being_broken" covers that
 * window: a paid, non-void broken siege the worker has not settled and not given up on.
 * (Once released, `status` is "broken"; `seed --rearm` reopens it with a new vault.)
 * Vault lifecycle is NOT checked here: lib/vault/guards.ts siegeBlockedReason adds "not_guarding" on top.
 * `exceptSiegeId` ignores one siege (the one asking).
 */
export function castleClosedReason(castleId: string, opts: { exceptSiegeId?: string; now?: number; d?: Reader } = {}): CastleClosed | null {
  const d = opts.d ?? db();
  const c = d.select({ status: schema.castles.status, deadline: schema.castles.deadline }).from(schema.castles).where(eq(schema.castles.id, castleId)).get();
  if (!c) return "not_found";
  if (c.status === "broken") return "broken";
  if (c.status !== "open") return "closed";
  if (c.deadline <= (opts.now ?? Date.now())) return "expired";
  return pendingPaidBreak(castleId, opts) ? "being_broken" : null;
}

/**
 * The id of a PAID siege on this castle that ended broken and is waiting for its release (not void,
 * not settled, not given up on), or null. While one exists the vault belongs to that raider: nothing
 * may close the vault (lib/vault/close refuses with "being_broken"), whatever the deadline says —
 * SiegeVault.release has no deadline check, so a break that ended in time is still payable after it.
 */
export function pendingPaidBreak(castleId: string, opts: { exceptSiegeId?: string; d?: Reader } = {}): string | null {
  const d = opts.d ?? db();
  const s = schema.sieges;
  const where = [
    eq(s.castleId, castleId),
    eq(s.status, "broken"),
    eq(s.free, false),
    isNull(s.voidReason),
    isNull(s.settledAt),
    lt(s.chainAttempts, MAX_CHAIN_ATTEMPTS),
  ];
  if (opts.exceptSiegeId) where.push(ne(s.id, opts.exceptSiegeId));
  return d.select({ id: s.id }).from(s).where(and(...where)).get()?.id ?? null;
}
