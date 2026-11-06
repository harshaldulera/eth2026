// STUB — Lane C replaces with Arkiv entities (castles, sieges, profiles); keep the signature.
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/config/env";
import { listCastles } from "@/lib/castles";
import { listSieges } from "@/lib/siege/read";
import type { ArkivPort, Castle, CastleFilter, Profile, Siege } from "@/lib/types";

/**
 * Reads go straight to the server's SQLite copy (castles + sieges tables). Writes only remember the
 * last payload in memory and hand back a stable key — the DB is already the source of truth here.
 */

/**
 * The Arkiv `castle` entity (plan C1): annotations the board filters on, plus the public Castle as
 * payload. Never includes orders (Castle has none). Expires at the vault deadline.
 */
export type CastleEntity = {
  key: string;
  owner: string;
  expiresAt: number;
  annotations: {
    tier: Castle["tier"];
    status: Castle["status"];
    vaultState: Castle["vaultState"];
    transport: Castle["transport"];
    protectedTool: string;
    pot: string;
    fee: string;
    streak: number;
  };
  payload: Castle;
};

export function castleEntity(castle: Castle): CastleEntity {
  return {
    key: `arkiv-stub:castle:${castle.id}`,
    owner: castle.owner,
    expiresAt: castle.deadline,
    annotations: {
      tier: castle.tier,
      status: castle.status,
      vaultState: castle.vaultState,
      transport: castle.transport,
      protectedTool: castle.protectedTool,
      pot: castle.pot,
      fee: castle.fee,
      streak: castle.streak,
    },
    payload: castle,
  };
}

const g = globalThis as unknown as { __arkivStub?: Map<string, unknown> };
const written = (g.__arkivStub ??= new Map<string, unknown>());

/** What the stub was last asked to write (tests / debug). */
export function arkivStubWrites(): ReadonlyMap<string, unknown> {
  return written;
}

function guardianProfile(wallet: string): Profile | null {
  const owned = db().select().from(schema.castles).where(eq(schema.castles.owner, wallet)).all();
  if (!owned.length) return null;
  const ids = owned.map((c) => c.id);
  const ended = db()
    .select({ status: schema.sieges.status, free: schema.sieges.free, castleId: schema.sieges.castleId })
    .from(schema.sieges)
    .where(and(inArray(schema.sieges.castleId, ids), isNotNull(schema.sieges.attemptTx)))
    .all();
  const feeBy = new Map(owned.map((c) => [c.id, c.feeTinybar]));
  const bps = env().FEE_SPLIT_CASTELLAN_BPS;
  const earned = ended
    .filter((s) => !s.free && (s.status === "held" || s.status === "banished"))
    .reduce((sum, s) => sum + Math.floor(((feeBy.get(s.castleId) ?? 0) * bps) / 10_000), 0);
  return {
    wallet,
    kind: "guardian",
    sieges: owned.reduce((n, c) => n + c.siegeCount, 0),
    breaks: db()
      .select({ id: schema.sieges.id })
      .from(schema.sieges)
      .where(and(inArray(schema.sieges.castleId, ids), eq(schema.sieges.status, "broken")))
      .all().length,
    streak: Math.max(...owned.map((c) => c.streak)),
    earned: String(earned),
  };
}

function raiderProfile(wallet: string): Profile | null {
  const rows = db()
    .select()
    .from(schema.sieges)
    .where(eq(schema.sieges.raider, wallet))
    .orderBy(schema.sieges.createdAt)
    .all();
  if (!rows.length) return null;
  let streak = 0;
  for (const r of rows) {
    if (r.status === "broken") streak += 1;
    else if (r.status === "held" || r.status === "banished") streak = 0;
  }
  return {
    wallet,
    kind: "raider",
    sieges: rows.length,
    breaks: rows.filter((r) => r.status === "broken").length,
    streak,
    earned: String(rows.reduce((n, r) => n + (r.releaseAmountTinybar ?? 0), 0)),
  };
}

export const arkiv: ArkivPort = {
  async writeCastle(castle: Castle) {
    const entity = castleEntity(castle);
    written.set(entity.key, entity);
    return { key: entity.key };
  },
  async writeSiege(siege: Siege) {
    const key = `arkiv-stub:siege:${siege.id}`;
    written.set(key, siege);
    return { key };
  },
  /**
   * Board query. Only `guarding` castles take sieges, so with no `vaultState` in the filter this
   * lists guarding castles only (plan C1/C7). Pass an explicit vaultState to see other states.
   */
  async listCastles(filter?: CastleFilter) {
    return listCastles({ ...filter, vaultState: filter?.vaultState ?? "guarding" });
  },
  async liveSieges() {
    return listSieges({ status: "in_progress", limit: 100 });
  },
  async profile(wallet: string) {
    return guardianProfile(wallet) ?? raiderProfile(wallet);
  },
};
