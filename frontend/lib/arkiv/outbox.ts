/**
 * The Arkiv outbox. Writers (Next routes, the worker, scripts — separate processes) only insert a
 * row here, which is instant. One drainer (`npm run arkiv`) sends the rows to Arkiv in batches.
 *
 * Why: an Arkiv write is a transaction that waits for a block (~2 s). Doing it inline would stall a
 * siege, and two processes signing with the same wallet would collide on nonces. The outbox also
 * coalesces (only the newest payload per entity is sent) and survives RPC outages (rows stay until
 * they land).
 *
 * A queued castle becomes two entities (see schema.ts): the Owner-owned `castle` listing,
 * created once (readonly, then `changeOwnership`), and the arena-owned `castleState`, patched on
 * every change. If the Owner deletes their listing, the drainer notices and removes the state
 * entity too: the castle is delisted, and nothing re-publishes it.
 *
 * Tables live next to the app's SQLite tables but are created here, so Lane A's migrations stay
 * untouched: arkiv_entities (kind+id → entity key, last fingerprint, expiry), arkiv_outbox, arkiv_meta.
 */
import { getAddress, type Hex } from "viem";
import { ExpirationTime } from "@arkiv-network/sdk";
import type { Expiry } from "@arkiv-network/sdk/entity";
import { eq } from "@arkiv-network/sdk/query";
import { accountEvmAddress, stubEvmAddress } from "@/lib/chain/mirror";
import { db } from "@/lib/db";
import type { Castle, Profile, Siege } from "@/lib/types";
import { arenaAddress, arkivReader, arkivWriter } from "./client";
import { vaultListingValues, vaultStatusValues, fingerprint, profileValues, opValues } from "./codec";
import { arkivConfig } from "./config";
import { SCHEMA_VERSION, schemas, type EntityKind } from "./schema";

// ─── Storage ───────────────────────────────────────────────────────────────

type Sqlite = { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } };
const ready = new WeakSet<object>();

function sql(): Sqlite {
  const s = (db() as unknown as { $client: Sqlite }).$client;
  if (!ready.has(s)) {
    s.exec(`
      CREATE TABLE IF NOT EXISTS arkiv_entities (
        kind TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL, updated_at TEXT NOT NULL, tx TEXT, owner TEXT,
        PRIMARY KEY (kind, id));
      CREATE TABLE IF NOT EXISTS arkiv_outbox (
        kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, fingerprint TEXT NOT NULL,
        force INTEGER NOT NULL DEFAULT 0, enqueued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, PRIMARY KEY (kind, id));
      CREATE TABLE IF NOT EXISTS arkiv_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    try {
      s.exec("ALTER TABLE arkiv_entities ADD COLUMN owner TEXT");
    } catch {
      // column already there
    }
    // Entity keys belong to one namespace: switching namespaces starts from a clean slate.
    const ns = arkivConfig().namespace;
    const known = (s.prepare("SELECT v FROM arkiv_meta WHERE k = 'namespace'").get() as { v: string } | undefined)?.v;
    // ...and so does a schema layout change (entity names or columns): old records name old kinds.
    const layout = (s.prepare("SELECT v FROM arkiv_meta WHERE k = 'schema_version'").get() as { v: string } | undefined)?.v;
    if (known !== ns || layout !== SCHEMA_VERSION) {
      s.exec("DELETE FROM arkiv_entities; DELETE FROM arkiv_outbox; DELETE FROM arkiv_meta WHERE k = 'delist_check'");
      // An Owner's delisting is a fact about the vault, not about the column layout: keep it across
      // a layout change, so a vault its Owner took down is never republished. A new namespace is a
      // separate deployment, so it starts without them.
      if (known !== ns) s.exec("DELETE FROM arkiv_meta WHERE k LIKE 'delisted:%'");
      s.prepare("INSERT INTO arkiv_meta (k, v) VALUES ('namespace', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(ns);
      s.prepare("INSERT INTO arkiv_meta (k, v) VALUES ('schema_version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(SCHEMA_VERSION);
    }
    ready.add(s);
  }
  return s;
}

export type EntityRecord = { kind: EntityKind; id: string; key: Hex; fingerprint: string; expiresAtMs: number; updatedAt: string; tx: string | null; owner: string | null };
type OutboxRow = { kind: PayloadKind; id: string; payload: string; fingerprint: string; force: number; enqueued_at: number; attempts: number; last_error: string | null };

export function entityRecord(kind: EntityKind, id: string): EntityRecord | null {
  const r = sql().prepare("SELECT * FROM arkiv_entities WHERE kind = ? AND id = ?").get(kind, id) as
    | { kind: EntityKind; id: string; key: Hex; fingerprint: string; expires_at_ms: number; updated_at: string; tx: string | null; owner: string | null }
    | undefined;
  return r ? { kind: r.kind, id: r.id, key: r.key, fingerprint: r.fingerprint, expiresAtMs: r.expires_at_ms, updatedAt: r.updated_at, tx: r.tx, owner: r.owner } : null;
}

function saveRecord(r: Omit<EntityRecord, "updatedAt" | "owner"> & { owner?: string | null }) {
  sql()
    .prepare(
      `INSERT INTO arkiv_entities (kind, id, key, fingerprint, expires_at_ms, updated_at, tx, owner) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, id) DO UPDATE SET key = excluded.key, fingerprint = excluded.fingerprint,
         expires_at_ms = excluded.expires_at_ms, updated_at = excluded.updated_at, tx = excluded.tx, owner = COALESCE(excluded.owner, arkiv_entities.owner)`,
    )
    .run(r.kind, r.id, r.key, r.fingerprint, r.expiresAtMs, new Date().toISOString(), r.tx, r.owner ?? null);
}

const forgetRecord = (kind: EntityKind, id: string) => sql().prepare("DELETE FROM arkiv_entities WHERE kind = ? AND id = ?").run(kind, id);

const metaGet = (k: string) => (sql().prepare("SELECT v FROM arkiv_meta WHERE k = ?").get(k) as { v: string } | undefined)?.v;
const metaSet = (k: string, v: string) => sql().prepare("INSERT INTO arkiv_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(k, v);

/** Castles whose Owner deleted their listing. Never re-published. */
export const isDelisted = (castleId: string) => metaGet(`delisted:${castleId}`) !== undefined;
export function delistedCastles(): { castleId: string; at: string }[] {
  return (sql().prepare("SELECT k, v FROM arkiv_meta WHERE k LIKE 'delisted:%'").all() as { k: string; v: string }[]).map((r) => ({ castleId: r.k.slice(9), at: r.v }));
}

// ─── Payloads ──────────────────────────────────────────────────────────────

/** What a queued write carries: the public domain object (never orders) plus the Swarm ref for sieges. */
export type Payload =
  | { kind: "vault"; data: Castle }
  | { kind: "op"; data: Siege; swarmRef?: string }
  | { kind: "guardProfile" | "operatorProfile"; data: Profile };
type PayloadKind = Payload["kind"];

const idOf = (p: Payload) => (p.kind === "vault" || p.kind === "op" ? p.data.id : p.data.wallet);

/** The values whose change means "send it" (castle: the state entity, minus the link columns). */
function coreValues(p: Payload) {
  switch (p.kind) {
    case "vault": {
      const all: Record<string, unknown> = { ...vaultStatusValues(p.data, { ownerWallet: "", listingKey: "" }) };
      delete all.ownerWallet;
      delete all.listingKey;
      return all;
    }
    case "op":
      return opValues(p.data, p.swarmRef);
    default:
      return profileValues(p.data);
  }
}

export const payloadFingerprint = (p: Payload) => fingerprint(coreValues(p) as Record<string, { type: string; value: unknown }>);

/** The arena-owned entity a payload maps to (castles: the state entity). */
const stateKind = (p: Payload): EntityKind => (p.kind === "vault" ? "vaultStatus" : p.kind);

/**
 * Queue a write. No-op when Arkiv already holds exactly these values (unless `force`, used to extend
 * a live siege's lifetime), or when the Owner delisted the castle. A newer payload for the same
 * entity replaces an unsent older one.
 */
export function enqueue(p: Payload, opts: { force?: boolean } = {}): { queued: boolean; key?: Hex } {
  const id = idOf(p);
  if (p.kind === "vault" && isDelisted(id)) return { queued: false };
  const fp = payloadFingerprint(p);
  const rec = entityRecord(stateKind(p), id);
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
export const OP_TTL_MIN = 10;
/**
 * An ended op whose transcript is on Swarm stays this long past its end, as the public pointer to
 * that transcript. Matches the Swarm worker's keep-alive horizon (`KEEP_ALIVE_HORIZON_MS`, a test
 * holds them equal): the entity leaves Arkiv about when its transcript stops being kept alive.
 */
export const OP_ARCHIVE_DAYS = 7;
const MAX_LIFE_MS = 180 * DAY; // chain max is ~182.5 days

/** A reference to bytes really on Swarm (bare 64-hex), not the local stand-in's `swarm-stub:…`. */
export const isSwarmRef = (ref: string | undefined): ref is string => !!ref && /^[0-9a-f]{64}$/i.test(ref);

/**
 * When an op entity should expire. A live op, or an ended one with no transcript on Swarm: 10 minutes
 * past this write. An ended op whose transcript is on Swarm: a week past its end (never sooner than
 * the 10 minutes, so a reference that lands late still gets a short life rather than none).
 */
export function opExpiry(siege: Siege, swarmRef: string | undefined, now: number): { expiresAtMs: number; archived: boolean } {
  const short = now + OP_TTL_MIN * MIN;
  const endMs = siege.endedAt ? Date.parse(siege.endedAt) : NaN;
  if (!Number.isFinite(endMs) || !isSwarmRef(swarmRef)) return { expiresAtMs: short, archived: false };
  const archiveEnd = endMs + OP_ARCHIVE_DAYS * DAY;
  return archiveEnd > short ? { expiresAtMs: archiveEnd, archived: true } : { expiresAtMs: short, archived: false };
}

type Plan = { expiration: Expiry; expiresAtMs: number } | null;

function opPlan(p: Extract<Payload, { kind: "op" }>, now: number): { expiration: Expiry; expiresAtMs: number } {
  const { expiresAtMs, archived } = opExpiry(p.data, p.swarmRef, now);
  return { expiration: archived ? ExpirationTime.atDate(new Date(expiresAtMs)) : ExpirationTime.fromMinutes(OP_TTL_MIN), expiresAtMs };
}

/** Expiry for a create (null = do not create: the castle's deadline has passed). */
export function createLife(p: Payload, now: number): Plan {
  if (p.kind === "vault") {
    const target = Math.min(p.data.deadline, now + MAX_LIFE_MS);
    if (target <= now + MIN) return null;
    return { expiration: ExpirationTime.atDate(new Date(target)), expiresAtMs: target };
  }
  if (p.kind === "op") return opPlan(p, now);
  return { expiration: ExpirationTime.max(), expiresAtMs: now + MAX_LIFE_MS };
}

/** Extension for an update, only when it moves the expiry later (the chain refuses shortening). */
export function extendLife(p: Payload, current: number, now: number): Plan {
  if (p.kind === "vault") {
    const target = Math.min(p.data.deadline, now + MAX_LIFE_MS);
    return target > current + MIN ? { expiration: ExpirationTime.atDate(new Date(target)), expiresAtMs: target } : null;
  }
  if (p.kind === "op") {
    const plan = opPlan(p, now);
    return plan.expiresAtMs > current + 30_000 ? plan : null;
  }
  return current < now + 30 * DAY ? { expiration: ExpirationTime.max(), expiresAtMs: now + MAX_LIFE_MS } : null;
}

// ─── Draining ──────────────────────────────────────────────────────────────

const ID_COLUMN: Record<EntityKind, string> = { vault: "vaultId", vaultStatus: "vaultId", op: "opId", guardProfile: "wallet", operatorProfile: "wallet" };

type Found = { key: Hex; expiresAtMs: number };

/** Find an entity written earlier (another DB, a reset DB) so we patch it instead of duplicating it. */
async function adopt(kind: EntityKind, id: string, owner: string): Promise<Found | null> {
  const schema = schemas()[kind];
  // Untyped where/select: the id column differs per kind.
  const res = await (arkivReader() as unknown as {
    select(s: unknown): { from(s: unknown): { where(e: unknown): { ownedBy(a: string): { limit(n: number): { fetch(): Promise<{ entities: { $key: Hex; $expiresAt: bigint }[]; blockNumber: bigint }> } } } } };
  })
    .select({ $key: true, $expiresAt: true })
    .from(schema)
    .where(eq(ID_COLUMN[kind], id))
    .ownedBy(owner)
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
  const now = Date.now();
  const v = metaGet(LEASE_KEY);
  if (v) {
    const [who, until] = v.split("|");
    if (who !== holder && Number(until) > now) return false;
  }
  metaSet(LEASE_KEY, `${holder}|${now + LEASE_MS}`);
  return true;
}

export function releaseLease(holder: string) {
  if (metaGet(LEASE_KEY)?.startsWith(`${holder}|`)) sql().prepare("DELETE FROM arkiv_meta WHERE k = ?").run(LEASE_KEY);
}

const MAX_ATTEMPTS = 8;
const BATCH = 8;

/** One arena-owned write: a create, or a patch with an optional extension. */
type Op = {
  row: OutboxRow;
  kind: EntityKind;
  values: Record<string, unknown>;
  existing: Found | null;
  create: Plan;
  extend: Plan;
};

/**
 * The Owner's wallet for a castle: the EVM address of the Hedera account that owns the vault.
 * Strict: if the mirror node cannot be read, this throws and the castle waits for the next pass.
 * A fallback address would hand the listing to the wrong owner, and that cannot be taken back.
 * Placeholder owners (seed fixtures, not real Hedera ids) get the same deterministic address in
 * every mode.
 */
export async function ownerWalletOf(c: Castle): Promise<`0x${string}`> {
  if (/^0x[0-9a-fA-F]{40}$/.test(c.owner)) return getAddress(c.owner);
  if (/^\d+\.\d+\.\d+$/.test(c.owner)) return accountEvmAddress(c.owner, { strict: true });
  return stubEvmAddress(c.owner);
}

export type DrainResult = { sent: number; skipped: number; failed: number; delisted: string[]; txs: string[]; errors: string[] };

/** Send up to `max` queued writes. Returns what happened; never throws for RPC failures. */
export async function drain(opts: { holder?: string; max?: number; log?: (m: string) => void } = {}): Promise<DrainResult> {
  const holder = opts.holder ?? `pid${process.pid}`;
  const log = opts.log ?? (() => {});
  const out: DrainResult = { sent: 0, skipped: 0, failed: 0, delisted: [], txs: [], errors: [] };
  if (!takeLease(holder)) return out;
  const now = Date.now();

  try {
    out.delisted = await checkDelistings(now, log);
  } catch (e) {
    log(`arkiv: delisting check failed: ${short(e)}`);
  }

  const rows = sql()
    .prepare("SELECT * FROM arkiv_outbox ORDER BY attempts ASC, enqueued_at ASC LIMIT ?")
    .all(opts.max ?? BATCH * 3) as OutboxRow[];

  // Phase A: Owner-owned listings that do not exist yet.
  type Listing = { row: OutboxRow; castle: Castle; ownerWallet: string; values: Record<string, unknown>; plan: NonNullable<Plan> };
  const listings: Listing[] = [];
  const links = new Map<string, { listingKey: Hex; ownerWallet: string }>();
  for (const row of rows) {
    if (row.kind !== "vault") continue;
    const castle = (JSON.parse(row.payload) as Extract<Payload, { kind: "vault" }>).data;
    if (isDelisted(castle.id)) {
      done(row);
      continue;
    }
    try {
      const ownerWallet = await ownerWalletOf(castle);
      const rec = entityRecord("vault", castle.id);
      let found: Found | null = rec ? { key: rec.key, expiresAtMs: rec.expiresAtMs } : null;
      if (!found) {
        let foundOwner = ownerWallet;
        found = await adopt("vault", castle.id, ownerWallet);
        if (!found) {
          found = await adopt("vault", castle.id, arenaAddress());
          foundOwner = arenaAddress();
        }
        if (found) saveRecord({ kind: "vault", id: castle.id, key: found.key, fingerprint: "adopted", expiresAtMs: found.expiresAtMs, tx: null, owner: foundOwner });
      }
      if (found) {
        links.set(castle.id, { listingKey: found.key, ownerWallet });
        continue;
      }
      const plan = createLife({ kind: "vault", data: castle }, now);
      if (!plan) continue; // expired castle: the state op below skips it too
      listings.push({ row, castle, ownerWallet, values: vaultListingValues(castle), plan });
    } catch (e) {
      fail(row, e, out, log);
    }
  }
  if (listings.length) {
    const s = schemas();
    try {
      const res = await arkivWriter().executeBatch({
        creates: listings.map((l) => ({
          schema: s.vault,
          values: l.values,
          expiration: l.plan.expiration,
          flags: { readonly: true, permissionlessExtension: true },
        })),
      } as never);
      listings.forEach((l, i) => {
        const key = res.createdEntities[i];
        if (!key) return;
        saveRecord({ kind: "vault", id: l.castle.id, key, fingerprint: "pending-ownership", expiresAtMs: l.plan.expiresAtMs, tx: res.txHash, owner: arenaAddress() });
        links.set(l.castle.id, { listingKey: key, ownerWallet: l.ownerWallet });
      });
      out.txs.push(res.txHash);
      log(`arkiv: ${listings.length} listing(s) created`);
    } catch (e) {
      for (const l of listings) fail(l.row, e, out, log);
    }
  }

  // Phase B: ownership hand-overs, arena-owned creates/patches, extensions.
  const ownership: { castleId: string; entityKey: Hex; newOwner: string }[] = [];
  for (const [castleId, link] of links) {
    const rec = entityRecord("vault", castleId);
    if (rec && rec.owner && rec.owner.toLowerCase() !== link.ownerWallet.toLowerCase()) ownership.push({ castleId, entityKey: link.listingKey, newOwner: link.ownerWallet });
  }

  const ops: Op[] = [];
  for (const row of rows) {
    if (listings.some((l) => l.row === row && !links.has(l.castle.id))) continue; // its listing failed this pass
    const payload = JSON.parse(row.payload) as Payload;
    const kind = stateKind(payload);
    let values: Record<string, unknown>;
    if (payload.kind === "vault") {
      const link = links.get(payload.data.id);
      if (!link) continue; // delisted, expired or failed above
      values = vaultStatusValues(payload.data, link);
      // The listing's own expiry follows the deadline too (permissionlessExtension lets the arena push it).
      const idRec = entityRecord("vault", payload.data.id);
      const idExt = idRec ? extendLife(payload, idRec.expiresAtMs, now) : null;
      if (idRec && idExt) ops.push({ row, kind: "vault", values: {}, existing: { key: idRec.key, expiresAtMs: idRec.expiresAtMs }, create: null, extend: idExt });
    } else values = coreValues(payload) as Record<string, unknown>;

    let existing: Found | null = null;
    const rec = entityRecord(kind, row.id);
    if (rec) existing = { key: rec.key, expiresAtMs: rec.expiresAtMs };
    else {
      try {
        existing = await adopt(kind, row.id, arenaAddress());
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
      ops.push({ row, kind, values, existing, create: null, extend });
    } else {
      const create = createLife(payload, now);
      if (!create) {
        done(row); // an expired castle: nothing to publish
        out.skipped += 1;
        continue;
      }
      ops.push({ row, kind, values, existing: null, create, extend: null });
    }
  }

  for (let i = 0; i < ops.length || (i === 0 && ownership.length); i += BATCH) {
    const chunk = ops.slice(i, i + BATCH);
    const own = i === 0 ? ownership : [];
    try {
      await send(chunk, own, out);
    } catch {
      // Isolate the bad one: retry each on its own.
      for (const o of own) {
        try {
          await send([], [o], out);
        } catch (e) {
          out.errors.push(`ownership:${o.castleId}: ${short(e)}`);
          out.failed += 1;
        }
      }
      for (const op of chunk) {
        try {
          await send([op], [], out);
        } catch (e) {
          // A patch on an entity that expired or vanished: forget the key, the next try re-creates it.
          if (op.existing && op.kind !== "vault") forgetRecord(op.kind, op.row.id);
          fail(op.row, e, out, log);
        }
      }
    }
  }
  if (out.sent) log(`arkiv: ${out.sent} write(s) in ${out.txs.length} tx`);
  return out;
}

async function send(chunk: Op[], ownership: { castleId: string; entityKey: Hex; newOwner: string }[], out: DrainResult) {
  if (!chunk.length && !ownership.length) return;
  const s = schemas();
  const creates = chunk.filter((o) => o.create);
  const patches = chunk.filter((o) => o.existing && !o.create && o.kind !== "vault");
  const extensions = chunk.filter((o) => o.existing && o.extend);
  const res = await arkivWriter().executeBatch({
    creates: creates.map((o) => ({ schema: s[o.kind], values: o.values, expiration: o.create!.expiration })),
    patches: patches.map((o) => ({ schema: s[o.kind], entityKey: o.existing!.key, set: o.values })),
    extensions: extensions.map((o) => ({ entityKey: o.existing!.key, expiration: o.extend!.expiration })),
    ownershipChanges: ownership.map((o) => ({ entityKey: o.entityKey, newOwner: o.newOwner })),
  } as never);
  creates.forEach((o, i) => {
    const key = res.createdEntities[i];
    if (key) saveRecord({ kind: o.kind, id: o.row.id, key, fingerprint: o.row.fingerprint, expiresAtMs: o.create!.expiresAtMs, tx: res.txHash, owner: arenaAddress() });
    done(o.row);
  });
  for (const o of patches) {
    saveRecord({ kind: o.kind, id: o.row.id, key: o.existing!.key, fingerprint: o.row.fingerprint, expiresAtMs: o.extend?.expiresAtMs ?? o.existing!.expiresAtMs, tx: res.txHash });
    done(o.row);
  }
  for (const o of extensions) {
    if (o.kind !== "vault") continue; // listing extensions: the state op above already closed the row
    const rec = entityRecord("vault", o.row.id);
    if (rec) saveRecord({ ...rec, expiresAtMs: o.extend!.expiresAtMs, tx: res.txHash });
  }
  for (const o of ownership) {
    const rec = entityRecord("vault", o.castleId);
    if (rec) saveRecord({ ...rec, fingerprint: "owned", tx: res.txHash, owner: o.newOwner });
  }
  out.sent += creates.length + patches.length + ownership.length;
  out.txs.push(res.txHash);
}

const DELIST_CHECK_MS = 60_000;

/**
 * Every minute: is every Owner-owned listing still there? If one is gone before its expiry,
 * the Owner deleted it. Remove the arena's state entity and remember the castle as delisted.
 */
async function checkDelistings(now: number, log: (m: string) => void): Promise<string[]> {
  const last = Number(metaGet("delist_check") ?? 0);
  if (now - last < DELIST_CHECK_MS) return [];
  metaSet("delist_check", String(now));
  const recs = sql().prepare("SELECT * FROM arkiv_entities WHERE kind = 'vault' AND owner IS NOT NULL AND expires_at_ms > ?").all(now + 2 * MIN) as {
    id: string;
    key: Hex;
    owner: string;
  }[];
  const gone: string[] = [];
  for (const r of recs) {
    if (r.owner.toLowerCase() === arenaAddress().toLowerCase()) continue; // not handed over yet
    try {
      await arkivReader().getEntity(r.key);
    } catch (e) {
      if (!/NoEntityFound|not found/i.test(`${(e as Error)?.name} ${short(e)}`)) continue; // RPC trouble is not a delisting
      gone.push(r.id);
    }
  }
  for (const castleId of gone) {
    const state = entityRecord("vaultStatus", castleId);
    try {
      if (state) await arkivWriter().deleteEntity({ entityKey: state.key });
      metaSet(`delisted:${castleId}`, new Date(now).toISOString());
      forgetRecord("vaultStatus", castleId);
      forgetRecord("vault", castleId);
      sql().prepare("DELETE FROM arkiv_outbox WHERE kind = 'vault' AND id = ?").run(castleId);
      log(`arkiv: castle ${castleId} delisted by its Owner; state entity removed`);
    } catch (e) {
      log(`arkiv: could not remove state of delisted castle ${castleId}: ${short(e)}`);
    }
  }
  return gone;
}

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 300);

/** Delete the row only if no newer payload replaced it while we were sending. */
function done(row: OutboxRow) {
  sql().prepare("DELETE FROM arkiv_outbox WHERE kind = ? AND id = ? AND fingerprint = ? AND enqueued_at = ?").run(row.kind, row.id, row.fingerprint, row.enqueued_at);
}

function fail(row: OutboxRow, e: unknown, out: DrainResult, log: (m: string) => void) {
  const msg = short(e);
  out.failed += 1;
  out.errors.push(`${row.kind}:${row.id}: ${msg}`);
  if (row.attempts + 1 >= MAX_ATTEMPTS) {
    log(`arkiv: giving up on ${row.kind} ${row.id} after ${MAX_ATTEMPTS} tries: ${msg}`);
    sql().prepare("DELETE FROM arkiv_outbox WHERE kind = ? AND id = ?").run(row.kind, row.id);
    return;
  }
  sql().prepare("UPDATE arkiv_outbox SET attempts = attempts + 1, last_error = ? WHERE kind = ? AND id = ?").run(msg, row.kind, row.id);
}
