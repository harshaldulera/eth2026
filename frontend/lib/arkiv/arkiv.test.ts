import { beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { db } from "@/lib/db";
import { getCastle, listCastles } from "@/lib/castles";
import { siege } from "@/lib/siege";
import type { CastleStatus, SiegeStatus, Tier, VaultState } from "@/lib/types";
import {
  OP_STATUS,
  TIER_NUMBER,
  VAULT_LIFECYCLE,
  VAULT_OUTCOME,
  fingerprint,
  opValues,
  profileValues,
  rowToCastle,
  rowToProfile,
  rowToSiege,
  vaultListingValues,
  vaultStatusValues,
} from "./codec";
import { describeCastleQuery } from "./queries";
import { enqueue, entityRecord, outboxStats, ownerWalletOf, payloadFingerprint } from "./outbox";
import { reconcile } from "./reconcile";
import { ENTITY_KINDS, SCHEMA_VERSION, schemas } from "./schema";
import { isArkivLive, listCastlesWithMeta } from ".";

/** A query row as the SDK returns it: every column as { type, value }. */
const asRow = (values: Record<string, { type: string; value: unknown }>) => values as unknown as Record<string, unknown>;
const link = { ownerWallet: "0x1111111111111111111111111111111111111111", listingKey: "0xabc" };

const raw = () => (db() as unknown as { $client: { exec(s: string): void; prepare(s: string): { all(): unknown[]; run(...a: unknown[]): unknown } } }).$client;
const outboxRows = () => raw().prepare("SELECT kind, id, force, attempts FROM arkiv_outbox ORDER BY kind, id").all() as { kind: string; id: string; force: number; attempts: number }[];

/** Words the game retired (lib/vocab): none may appear in what we publish on Arkiv. */
const RETIRED = /castle|castellan|siege|raider|guardian|broken|banish|dormant|wooden|stone|iron/i;

describe("arkiv vocabulary", () => {
  beforeEach(() => {
    freshFixtureDb();
  });

  it("entity names, column names and stored values use the game's words only", async () => {
    const s = schemas();
    expect(Object.keys(s)).toEqual(["vault", "vaultStatus", "op", "guardProfile", "operatorProfile"]);
    expect([...ENTITY_KINDS]).toEqual(Object.keys(s));
    for (const k of ENTITY_KINDS) expect(k).not.toMatch(RETIRED);
    // Every column of every entity, and every value we would write for every seeded vault and an op.
    const c = getCastle("castle_iron_warden")!;
    const op = await siege.start({ castleId: "castle_splinter_gate", raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
    const written = [
      vaultListingValues(c),
      vaultStatusValues(c, link),
      opValues(op),
      profileValues({ wallet: "0.0.w", kind: "raider", sieges: 1, breaks: 0, streak: 0, earned: "0" }),
    ];
    for (const values of written) {
      for (const [col, v] of Object.entries(values)) {
        expect(col, col).not.toMatch(RETIRED);
        if (v.type === "str" && !/Id$|Key$|Wallet$|Account$|Hash$|Ref$|Url$/.test(col) && col !== "name" && col !== "guardName" && col !== "voice")
          expect(String(v.value), `${col}=${String(v.value)}`).not.toMatch(RETIRED);
      }
    }
  });

  it("every app value maps to a game word and back, for tiers, op status, vault outcome and lifecycle", () => {
    const tiers: Tier[] = ["wooden", "stone", "iron"];
    expect(tiers.map((t) => TIER_NUMBER[t])).toEqual([1, 2, 3]);
    const ops: SiegeStatus[] = ["created", "in_progress", "held", "broken", "banished"];
    expect(ops.map((x) => OP_STATUS[x])).toEqual(["created", "live", "held", "breached", "lockdown"]);
    const outcomes: CastleStatus[] = ["open", "broken", "closed"];
    expect(outcomes.map((x) => VAULT_OUTCOME[x])).toEqual(["open", "breached", "closed"]);
    const states: VaultState[] = ["created", "connected", "verified", "funded", "guarding", "dormant", "broken", "closed"];
    expect(states.map((x) => VAULT_LIFECYCLE[x])).toEqual(["created", "connected", "verified", "funded", "guarding", "offline", "breached", "closed"]);
    // And back: every combination round-trips through a query row.
    const base = getCastle("castle_granite_hold")!;
    for (const tier of tiers)
      for (const status of outcomes)
        for (const vaultState of states) {
          const back = rowToCastle(asRow(vaultStatusValues({ ...base, tier, status, vaultState }, link)));
          expect([back.tier, back.status, back.vaultState]).toEqual([tier, status, vaultState]);
        }
  });

  it("an older local sync layout (old entity kinds) is dropped, not misread", () => {
    raw().exec(`
      CREATE TABLE IF NOT EXISTS arkiv_entities (kind TEXT NOT NULL, id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL,
        expires_at_ms INTEGER NOT NULL, updated_at TEXT NOT NULL, tx TEXT, owner TEXT, PRIMARY KEY (kind, id));
      CREATE TABLE IF NOT EXISTS arkiv_outbox (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, fingerprint TEXT NOT NULL,
        force INTEGER NOT NULL DEFAULT 0, enqueued_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, PRIMARY KEY (kind, id));
      CREATE TABLE IF NOT EXISTS arkiv_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      INSERT INTO arkiv_entities VALUES ('castleState', 'castle_x', '0xold', 'fp', 0, 'now', null, null);
      INSERT INTO arkiv_outbox (kind, id, payload, fingerprint, enqueued_at) VALUES ('castle', 'castle_x', '{}', 'fp', 0);
      INSERT INTO arkiv_meta VALUES ('namespace', 'siege');
    `);
    expect(outboxStats().pending).toBe(0); // first use under the new layout cleared the old rows
    expect(raw().prepare("SELECT COUNT(*) AS n FROM arkiv_entities").all()).toEqual([{ n: 0 }]);
    expect(raw().prepare("SELECT v FROM arkiv_meta WHERE k = 'schema_version'").all()).toEqual([{ v: SCHEMA_VERSION }]);
  });

  it("a layout change keeps an Owner's delisting: the vault they took down is never republished", () => {
    const c = getCastle("castle_granite_hold")!;
    raw().exec(`
      CREATE TABLE IF NOT EXISTS arkiv_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      INSERT INTO arkiv_meta VALUES ('namespace', 'siege');
      INSERT INTO arkiv_meta VALUES ('schema_version', '1');
      INSERT INTO arkiv_meta VALUES ('delisted:${c.id}', '2026-11-06T00:00:00Z');
    `);
    expect(enqueue({ kind: "vault", data: c })).toEqual({ queued: false });
    expect(raw().prepare("SELECT v FROM arkiv_meta WHERE k = 'schema_version'").all()).toEqual([{ v: SCHEMA_VERSION }]);
  });

  it("a new namespace is a separate deployment and starts without the old delistings", () => {
    const c = getCastle("castle_granite_hold")!;
    raw().exec(`
      CREATE TABLE IF NOT EXISTS arkiv_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      INSERT INTO arkiv_meta VALUES ('namespace', 'some-other-namespace');
      INSERT INTO arkiv_meta VALUES ('schema_version', '${SCHEMA_VERSION}');
      INSERT INTO arkiv_meta VALUES ('delisted:${c.id}', '2026-11-06T00:00:00Z');
    `);
    expect(enqueue({ kind: "vault", data: c }).queued).toBe(true);
  });
});

describe("arkiv", () => {
  beforeEach(() => {
    freshFixtureDb();
  });

  it("is always stub under the test runner, and the stub Grid reads SQLite", async () => {
    expect(isArkivLive()).toBe(false);
    const r = await listCastlesWithMeta();
    expect(r.meta.source).toBe("sqlite");
    expect(r.castles.every((c) => c.vaultState === "guarding")).toBe(true);
    const all = await listCastlesWithMeta({}, { allStates: true });
    expect(all.castles.length).toBe(listCastles().length);
  });

  it("a vault is an Owner-owned listing plus an arena-owned status; neither carries orders", () => {
    const c = getCastle("castle_iron_warden")!;
    const listing = vaultListingValues(c);
    const status = vaultStatusValues(c, link);
    expect(Object.keys(listing)).not.toContain("pot"); // nothing that moves is on the listing
    for (const v of [listing, status]) expect(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x))).not.toMatch(/orders/i);
    expect(status.listingKey.value).toBe("0xabc");
    expect(status.ownerWallet.value).toBe(link.ownerWallet);
  });

  it("the Owner's wallet is the EVM address of the Hedera account that owns the vault", async () => {
    const c = getCastle("castle_iron_warden")!;
    const a = await ownerWalletOf(c);
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(await ownerWalletOf(c)).toBe(a); // deterministic
    expect(await ownerWalletOf(getCastle("castle_splinter_gate")!)).not.toBe(a);
  });

  it("vault status values round-trip through a query row", () => {
    for (const c of listCastles()) {
      const back = rowToCastle(asRow(vaultStatusValues(c, link)));
      const { arkiv, ...plain } = back;
      expect({ ...plain, createdAt: undefined }).toEqual({ ...c, createdAt: undefined });
      expect(Date.parse(back.createdAt)).toBe(Date.parse(c.createdAt));
      expect(arkiv).toEqual({ listingKey: "0xabc", ownerWallet: link.ownerWallet });
    }
  });

  it("op and profile values round-trip (ops without messages)", async () => {
    const s = await siege.start({ castleId: "castle_splinter_gate", raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
    const back = rowToSiege(asRow(opValues(s, "swarm-stub:abc")));
    expect(back).toMatchObject({ id: s.id, castleId: s.castleId, raider: "0.0.r", status: s.status, free: true, transport: s.transport, messages: [], swarmRef: "swarm-stub:abc" });
    for (const status of ["created", "in_progress", "held", "broken", "banished"] as const) expect(rowToSiege(asRow(opValues({ ...s, status }))).status).toBe(status);
    const p = { wallet: "0.0.w", kind: "raider" as const, sieges: 4, breaks: 1, streak: 1, earned: "500000000" };
    expect(rowToProfile(asRow(profileValues(p)), "raider")).toEqual(p);
  });

  it("fingerprints ignore key order and change when a value changes", () => {
    const c = getCastle("castle_granite_hold")!;
    const a = vaultStatusValues(c, link) as Record<string, { type: string; value: unknown }>;
    const reversed = Object.fromEntries(Object.entries(a).reverse());
    expect(fingerprint(reversed)).toBe(fingerprint(a));
    expect(payloadFingerprint({ kind: "vault", data: { ...c, pot: "1" } })).not.toBe(payloadFingerprint({ kind: "vault", data: c }));
  });

  it("the outbox coalesces writes per entity and skips values Arkiv already holds", () => {
    const c = getCastle("castle_granite_hold")!;
    expect(enqueue({ kind: "vault", data: c }).queued).toBe(true);
    expect(enqueue({ kind: "vault", data: { ...c, pot: "2100000000" } }).queued).toBe(true);
    expect(outboxRows().filter((r) => r.id === c.id)).toHaveLength(1);
    expect(outboxStats().pending).toBe(1);

    // Pretend the drainer published exactly these values (the status entity is what changes).
    const fp = payloadFingerprint({ kind: "vault", data: c });
    raw()
      .prepare("INSERT INTO arkiv_entities (kind, id, key, fingerprint, expires_at_ms, updated_at) VALUES ('vaultStatus', ?, '0xabc', ?, ?, 'now')")
      .run(c.id, fp, Date.now() + 60_000);
    expect(entityRecord("vaultStatus", c.id)?.key).toBe("0xabc");
    expect(enqueue({ kind: "vault", data: c })).toEqual({ queued: false, key: "0xabc" });
    expect(enqueue({ kind: "vault", data: c }, { force: true }).queued).toBe(true);
  });

  it("a delisted vault is never queued again", () => {
    const c = getCastle("castle_granite_hold")!;
    outboxStats(); // creates the outbox tables
    raw().prepare("INSERT INTO arkiv_meta (k, v) VALUES (?, ?)").run(`delisted:${c.id}`, "2026-11-06T00:00:00Z");
    expect(enqueue({ kind: "vault", data: c })).toEqual({ queued: false });
  });

  it("reconcile queues every vault and Owner once, then nothing until something changes", async () => {
    const first = reconcile();
    expect(first.vaults).toBe(listCastles().length);
    expect(first.profiles).toBeGreaterThan(0);
    const before = outboxRows().length;
    reconcile();
    expect(outboxRows().length).toBe(before);

    const s = await siege.start({ castleId: "castle_splinter_gate", raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
    reconcile();
    expect(outboxRows().some((r) => r.kind === "op" && r.id === s.id)).toBe(true);
  });

  it("describes The Grid's query the way it runs, with the values Arkiv stores", () => {
    expect(describeCastleQuery()).toBe('vaultStatus WHERE vaultState = "guarding" ORDER BY pot DESC');
    expect(describeCastleQuery({ tier: "stone", sort: "streak" })).toBe('vaultStatus WHERE tier = 2 AND vaultState = "guarding" ORDER BY streak DESC');
    expect(describeCastleQuery({ status: "broken", vaultState: "dormant" })).toBe('vaultStatus WHERE status = "breached" AND vaultState = "offline" ORDER BY pot DESC');
    expect(describeCastleQuery({}, { allStates: true })).toBe("vaultStatus ORDER BY pot DESC");
  });
});
