/**
 * The Arkiv outbox. Writers (Next routes, the worker, scripts — separate processes) only insert a
 * row here, which is instant. One drainer (`npm run arkiv`) sends the rows to Arkiv in batches.
 *
 * Why: an Arkiv write is a transaction that waits for a block (~2 s). Doing it inline would stall a
 * siege, and two processes signing with the same wallet would collide on nonces. The outbox also
 * coalesces (only the newest payload per entity is sent) and survives RPC outages (rows stay until
 * they land).
 *
 * Tables live next to the app's SQLite tables but are created here, so Lane A's migrations stay
 * untouched: arkiv_entities (id → entity key, last fingerprint, expiry), arkiv_outbox, arkiv_meta.
 */
import type { Hex } from "viem";
import { ExpirationTime } from "@arkiv-network/sdk";
import type { Expiry } from "@arkiv-network/sdk/entity";
import { eq } from "@arkiv-network/sdk/query";
import { db } from "@/lib/db";
import type { Castle, Profile, Siege } from "@/lib/types";
import { arenaAddress, arkivReader, arkivWriter } from "./client";
import { castleValues, fingerprint, profileValues, siegeValues } from "./codec";
import { schemas, type EntityKind } from "./schema";

// ─── Storage ───────────────────────────────────────────────────────────────

type Sqlite = { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } };
const ready = new WeakSet<object>();

function sql(): Sqlite {
  const s = (db() as unknown as { $client: Sqlite }).$client;
  if (!ready.has(s)) {
    s.exec(`
      CREATE TABLE IF NOT EXISTS arkiv_entities (
        kind TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL, updated_at TEXT NOT NULL, tx TEXT,
        PRIMARY KEY (kind, id));
      CREATE TABLE IF NOT EXISTS arkiv_outbox (
        kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, fingerprint TEXT NOT NULL,
        force INTEGER NOT NULL DEFAULT 0, enqueued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, PRIMARY KEY (kind, id));
      CREATE TABLE IF NOT EXISTS arkiv_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    ready.add(s);
  }
  return s;
}

export type EntityRecord = { kind: EntityKind; id: string; key: Hex; fingerprint: string; expiresAtMs: number; updatedAt: string; tx: string | null };
type OutboxRow = { kind: EntityKind; id: string; payload: string; fingerprint: string; force: number; enqueued_at: number; attempts: number; last_error: string | null };

export function entityRecord(kind: EntityKind, id: string): EntityRecord | null {
  const r = sql().prepare("SELECT * FROM arkiv_entities WHERE kind = ? AND id = ?").get(kind, id) as
    | { kind: EntityKind; id: string; key: Hex; fingerprint: string; expires_at_ms: number; updated_at: string; tx: string | null }
    | undefined;
  return r ? { kind: r.kind, id: r.id, key: r.key, fingerprint: r.fingerprint, expiresAtMs: r.expires_at_ms, updatedAt: r.updated_at, tx: r.tx } : null;
}

function saveRecord(r: Omit<EntityRecord, "updatedAt">) {
  sql()
    .prepare(
      `INSERT INTO arkiv_entities (kind, id, key, fingerprint, expires_at_ms, updated_at, tx) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, id) DO UPDATE SET key = excluded.key, fingerprint = excluded.fingerprint,
         expires_at_ms = excluded.expires_at_ms, updated_at = excluded.updated_at, tx = excluded.tx`,
    )
    .run(r.kind, r.id, r.key, r.fingerprint, r.expiresAtMs, new Date().toISOString(), r.tx);
}

const forgetRecord = (kind: EntityKind, id: string) => sql().prepare("DELETE FROM arkiv_entities WHERE kind = ? AND id = ?").run(kind, id);

// ─── Payloads ──────────────────────────────────────────────────────────────

/** What a queued write carries: the public domain object (never orders) plus the Swarm ref for sieges. */
export type Payload =
  | { kind: "castle"; data: Castle }
  | { kind: "siege"; data: Siege; swarmRef?: string }
  | { kind: "guardianProfile" | "raiderProfile"; data: Profile };

const idOf = (p: Payload) => (p.kind === "castle" || p.kind === "siege" ? p.data.id : p.data.wallet);

function valuesOf(p: Payload) {
  switch (p.kind) {
    case "castle":
      return castleValues(p.data);
    case "siege":
      return siegeValues(p.data, p.swarmRef);
    default:
      return profileValues(p.data);
  }
}

export const payloadFingerprint = (p: Payload) => fingerprint(valuesOf(p) as Record<string, { type: string; value: unknown }>);

/**
 * Queue a write. No-op when Arkiv already holds exactly these values (unless `force`, used to extend
 * a live siege's lifetime). A newer payload for the same entity replaces an unsent older one.
 */
export function enqueue(p: Payload, opts: { force?: boolean } = {}): { queued: boolean; key?: Hex } {
  const id = idOf(p);
  const fp = payloadFingerprint(p);
  const rec = entityRecord(p.kind, id);
  if (rec && rec.fingerprint === fp && !opts.force) return { queued: false, key: rec.key };
  sql()
    .prepare(
      `INSERT INTO arkiv_outbox (kind, id, payload, fingerprint, force, enqueued_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, id) DO UPDATE SET payload = excluded.payload, fingerprint = excluded.fingerprint,
         force = MAX(arkiv_outbox.force, excluded.force), attempts = 0, last_error = NULL`,
    )
    .run(p.kind, id, JSON.stringify(p), fp, opts.force ? 1 : 0, Date.now());
  return { queued: true, key: rec?.key };
}

export function outboxStats(): { pending: number; failing: number; oldestMs: number | null } {
  const r = sql().prepare("SELECT COUNT(*) AS n, SUM(attempts > 0) AS f, MIN(enqueued_at) AS o FROM arkiv_outbox").get() as { n: number; f: number | null; o: number | null };
  return { pending: r.n, failing: r.f ?? 0, oldestMs: r.o };
}

// ─── Lifetimes ─────────────────────────────────────────────────────────────

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** A siege lives this long past its last write; live sieges are refreshed before it runs out. */
export const SIEGE_TTL_MIN = 10;
const MAX_LIFE_MS = 180 * DAY; // chain max is ~182.5 days

type Plan = { expiration: Expiry; expiresAtMs: number } | null;

/** Expiry for a create (null = do not create: the castle's deadline has passed). */
function createLife(p: Payload, now: number): Plan {
  if (p.kind === "castle") {
    const target = Math.min(p.data.deadline, now + MAX_LIFE_MS);
    if (target <= now + MIN) return null;
    return { expiration: ExpirationTime.atDate(new Date(target)), expiresAtMs: target };
  }
  if (p.kind === "siege") return { expiration: ExpirationTime.fromMinutes(SIEGE_TTL_MIN), expiresAtMs: now + SIEGE_TTL_MIN * MIN };
  return { expiration: ExpirationTime.max(), expiresAtMs: now + MAX_LIFE_MS };
}

/** Extension for an update, only when it moves the expiry later (the chain refuses shortening). */
function extendLife(p: Payload, current: number, now: number): Plan {
  if (p.kind === "castle") {
    const target = Math.min(p.data.deadline, now + MAX_LIFE_MS);
    return target > current + MIN ? { expiration: ExpirationTime.atDate(new Date(target)), expiresAtMs: target } : null;
  }
  if (p.kind === "siege") {
    const target = now + SIEGE_TTL_MIN * MIN;
    return target > current + 30_000 ? { expiration: ExpirationTime.fromMinutes(SIEGE_TTL_MIN), expiresAtMs: target } : null;
  }
  return current < now + 30 * DAY ? { expiration: ExpirationTime.max(), expiresAtMs: now + MAX_LIFE_MS } : null;
}

// ─── Draining ──────────────────────────────────────────────────────────────

const ID_COLUMN: Record<EntityKind, string> = { castle: "castleId", siege: "siegeId", guardianProfile: "wallet", raiderProfile: "wallet" };

/** Find an entity we wrote earlier (another DB, a reset DB) so we patch it instead of duplicating it. */
async function adopt(kind: EntityKind, id: string): Promise<{ key: Hex; expiresAtMs: number } | null> {
  const schema = schemas()[kind];
  // Untyped where/select: the id column differs per kind.
  const res = await (arkivReader() as unknown as {
    select(s: unknown): { from(s: unknown): { where(e: unknown): { ownedBy(a: string): { limit(n: number): { fetch(): Promise<{ entities: { $key: Hex; $expiresAt: bigint }[]; blockNumber: bigint }> } } } } };
  })
    .select({ $key: true, $expiresAt: true })
    .from(schema)
    .where(eq(ID_COLUMN[kind], id))
    .ownedBy(arenaAddress())
    .limit(1)
    .fetch();
  const e = res.entities[0];
  if (!e) return null;
  const blocksLeft = Number(e.$expiresAt - res.blockNumber);
  return { key: e.$key, expiresAtMs: Date.now() + Math.max(0, blocksLeft) * 2000 };
}

const LEASE_MS = 30_000;
const LEASE_KEY = "drain_lease";

/** Only one drainer at a time, across processes (two would collide on the wallet nonce). */
function takeLease(holder: string): boolean {
  const s = sql();
  const now = Date.now();
  const row = s.prepare("SELECT v FROM arkiv_meta WHERE k = ?").get(LEASE_KEY) as { v: string } | undefined;
  if (row) {
    const [who, until] = row.v.split("|");
    if (who !== holder && Number(until) > now) return false;
  }
  s.prepare("INSERT INTO arkiv_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(LEASE_KEY, `${holder}|${now + LEASE_MS}`);
  return true;
}

export function releaseLease(holder: string) {
  const row = sql().prepare("SELECT v FROM arkiv_meta WHERE k = ?").get(LEASE_KEY) as { v: string } | undefined;
  if (row?.v.startsWith(`${holder}|`)) sql().prepare("DELETE FROM arkiv_meta WHERE k = ?").run(LEASE_KEY);
}

const MAX_ATTEMPTS = 8;
const BATCH = 8;

type Op = {
  row: OutboxRow;
  payload: Payload;
  existing: { key: Hex; expiresAtMs: number } | null;
  create: Plan;
  extend: Plan;
};

export type DrainResult = { sent: number; skipped: number; failed: number; txs: string[]; errors: string[] };

/** Send up to `max` queued writes. Returns what happened; never throws for RPC failures. */
export async function drain(opts: { holder?: string; max?: number; log?: (m: string) => void } = {}): Promise<DrainResult> {
  const holder = opts.holder ?? `pid${process.pid}`;
  const log = opts.log ?? (() => {});
  const out: DrainResult = { sent: 0, skipped: 0, failed: 0, txs: [], errors: [] };
  if (!takeLease(holder)) return out;

  const rows = sql()
    .prepare("SELECT * FROM arkiv_outbox ORDER BY attempts ASC, enqueued_at ASC LIMIT ?")
    .all(opts.max ?? BATCH * 3) as OutboxRow[];
  const now = Date.now();

  const ops: Op[] = [];
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as Payload;
    let existing: Op["existing"] = null;
    const rec = entityRecord(row.kind, row.id);
    if (rec) existing = { key: rec.key, expiresAtMs: rec.expiresAtMs };
    else {
      try {
        existing = await adopt(row.kind, row.id);
      } catch (e) {
        fail(row, e, out, log);
        continue;
      }
    }
    if (existing) {
      const extend = extendLife(payload, existing.expiresAtMs, now);
      if (rec && rec.fingerprint === row.fingerprint && !extend) {
        done(row);
        out.skipped += 1;
        continue;
      }
      ops.push({ row, payload, existing, create: null, extend });
    } else {
      const create = createLife(payload, now);
      if (!create) {
        done(row); // an expired castle: nothing to publish
        out.skipped += 1;
        continue;
      }
      ops.push({ row, payload, existing: null, create, extend: null });
    }
  }

  for (let i = 0; i < ops.length; i += BATCH) {
    const chunk = ops.slice(i, i + BATCH);
    try {
      await send(chunk, out);
    } catch {
      // Isolate the bad one: retry each on its own.
      for (const op of chunk) {
        try {
          await send([op], out);
        } catch (e) {
          // A patch on an entity that expired or vanished: forget the key, the next try re-creates it.
          if (op.existing) forgetRecord(op.row.kind, op.row.id);
          fail(op.row, e, out, log);
        }
      }
    }
  }
  if (out.sent) log(`arkiv: ${out.sent} write(s) in ${out.txs.length} tx`);
  return out;
}

async function send(chunk: Op[], out: DrainResult) {
  const s = schemas();
  const creates = chunk.filter((o) => o.create);
  const patches = chunk.filter((o) => o.existing && !o.create);
  const extensions = patches.filter((o) => o.extend);
  const res = await arkivWriter().executeBatch({
    creates: creates.map((o) => ({
      schema: s[o.payload.kind],
      values: valuesOf(o.payload),
      expiration: o.create!.expiration,
    })),
    patches: patches.map((o) => ({ schema: s[o.payload.kind], entityKey: o.existing!.key, set: valuesOf(o.payload) })),
    extensions: extensions.map((o) => ({ entityKey: o.existing!.key, expiration: o.extend!.expiration })),
  } as never);
  creates.forEach((o, i) => {
    const key = res.createdEntities[i];
    if (key) saveRecord({ kind: o.row.kind, id: o.row.id, key, fingerprint: o.row.fingerprint, expiresAtMs: o.create!.expiresAtMs, tx: res.txHash });
    done(o.row);
  });
  for (const o of patches) {
    saveRecord({
      kind: o.row.kind,
      id: o.row.id,
      key: o.existing!.key,
      fingerprint: o.row.fingerprint,
      expiresAtMs: o.extend?.expiresAtMs ?? o.existing!.expiresAtMs,
      tx: res.txHash,
    });
    done(o.row);
  }
  out.sent += chunk.length;
  out.txs.push(res.txHash);
}

/** Delete the row only if no newer payload replaced it while we were sending. */
function done(row: OutboxRow) {
  sql().prepare("DELETE FROM arkiv_outbox WHERE kind = ? AND id = ? AND fingerprint = ? AND enqueued_at = ?").run(row.kind, row.id, row.fingerprint, row.enqueued_at);
}

function fail(row: OutboxRow, e: unknown, out: DrainResult, log: (m: string) => void) {
  const msg = (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);
  out.failed += 1;
  out.errors.push(`${row.kind}:${row.id}: ${msg}`);
  if (row.attempts + 1 >= MAX_ATTEMPTS) {
    log(`arkiv: giving up on ${row.kind} ${row.id} after ${MAX_ATTEMPTS} tries: ${msg}`);
    sql().prepare("DELETE FROM arkiv_outbox WHERE kind = ? AND id = ?").run(row.kind, row.id);
    return;
  }
  sql().prepare("UPDATE arkiv_outbox SET attempts = attempts + 1, last_error = ? WHERE kind = ? AND id = ?").run(msg, row.kind, row.id);
}
