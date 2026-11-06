/**
 * Lane C — Arkiv, the public, queryable copy of the board.
 *
 *   ARKIV_MODE=stub (default, and always in tests): writes are remembered in memory, reads come
 *     from the server's SQLite copy. Nothing touches a network.
 *   ARKIV_MODE=live: writes are queued in the outbox and sent by `npm run arkiv`; reads query the
 *     Rabdi testnet, falling back to SQLite (and saying so) if the RPC fails.
 *
 * Schemas: ./schema.ts. Queue and sender: ./outbox.ts. Sync from SQLite: ./reconcile.ts.
 */
import { listCastles } from "@/lib/castles";
import { listSieges } from "@/lib/siege/read";
import { swarmRefFor } from "@/lib/swarm/refs";
import type { ArkivPort, Castle, CastleFilter, Profile, Siege } from "@/lib/types";
import { isArkivLive } from "./config";
import { enqueue } from "./outbox";
import { guardianProfile, raiderProfile } from "./profiles";
import { describeCastleQuery, listCastlesLive, liveSiegesLive, profileLive } from "./queries";
import { castleEntity, stubWrites } from "./stub";

export { arkivStubWrites, castleEntity, type CastleEntity } from "./stub";
export { arkivLinks, isArkivLive } from "./config";
export { describeCastleQuery } from "./queries";

/** Where a read came from. `block` is the Arkiv block it was read at (live reads only). */
export type ReadMeta = { source: "arkiv" | "sqlite"; block?: string; query: string; error?: string };

const READ_TIMEOUT_MS = 5_000;

function withTimeout<T>(p: Promise<T>, ms = READ_TIMEOUT_MS): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`Arkiv read timed out after ${ms}ms`)), ms))]);
}

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);

type ListOpts = { allStates?: boolean };

const sqliteCastles = (filter: CastleFilter = {}, opts: ListOpts = {}) =>
  listCastles(opts.allStates ? filter : { ...filter, vaultState: filter.vaultState ?? "guarding" });

/**
 * The board query plus where it came from. The board shows `meta.block` as its proof.
 * With no vaultState it lists guarding castles only; `allStates` lists every castle instead.
 */
export async function listCastlesWithMeta(filter?: CastleFilter, opts: ListOpts = {}): Promise<{ castles: Castle[]; meta: ReadMeta }> {
  const query = describeCastleQuery(filter, opts);
  if (!isArkivLive()) return { castles: sqliteCastles(filter, opts), meta: { source: "sqlite", query } };
  try {
    const r = await withTimeout(listCastlesLive(filter, opts));
    return { castles: r.data, meta: { source: "arkiv", block: r.block.toString(), query } };
  } catch (e) {
    return { castles: sqliteCastles(filter, opts), meta: { source: "sqlite", query, error: short(e) } };
  }
}

export const arkiv: ArkivPort = {
  async writeCastle(castle: Castle) {
    if (!isArkivLive()) {
      const entity = castleEntity(castle);
      stubWrites.set(entity.key, entity);
      return { key: entity.key };
    }
    const r = enqueue({ kind: "castle", data: castle });
    return { key: r.key ?? `arkiv-pending:castle:${castle.id}` };
  },

  async writeSiege(siege: Siege) {
    if (!isArkivLive()) {
      const key = `arkiv-stub:siege:${siege.id}`;
      stubWrites.set(key, siege);
      return { key };
    }
    const r = enqueue({ kind: "siege", data: siege, swarmRef: swarmRefFor(siege.id) });
    return { key: r.key ?? `arkiv-pending:siege:${siege.id}` };
  },

  /**
   * Board query. Only `guarding` castles take sieges, so with no `vaultState` in the filter this
   * lists guarding castles only (plan C1/C7). Pass an explicit vaultState to see other states.
   */
  async listCastles(filter?: CastleFilter) {
    return (await listCastlesWithMeta(filter)).castles;
  },

  async liveSieges() {
    if (isArkivLive()) {
      try {
        return (await withTimeout(liveSiegesLive())).data;
      } catch {
        // fall through to SQLite
      }
    }
    return listSieges({ status: "in_progress", limit: 100 });
  },

  async profile(wallet: string): Promise<Profile | null> {
    if (isArkivLive()) {
      try {
        return (await withTimeout(profileLive(wallet))).data;
      } catch {
        // fall through to SQLite
      }
    }
    return guardianProfile(wallet) ?? raiderProfile(wallet);
  },
};
