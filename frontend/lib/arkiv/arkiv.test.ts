import { beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { db } from "@/lib/db";
import { getCastle, listCastles } from "@/lib/castles";
import { siege } from "@/lib/siege";
import { castleIdentityValues, castleStateValues, fingerprint, profileValues, rowToCastle, rowToProfile, rowToSiege, siegeValues } from "./codec";
import { describeCastleQuery } from "./queries";
import { castellanWallet, enqueue, entityRecord, outboxStats, payloadFingerprint } from "./outbox";
import { reconcile } from "./reconcile";
import { schemas } from "./schema";
import { isArkivLive, listCastlesWithMeta } from ".";

/** A query row as the SDK returns it: every column as { type, value }. */
const asRow = (values: Record<string, { type: string; value: unknown }>) => values as unknown as Record<string, unknown>;
const link = { castellan: "0x1111111111111111111111111111111111111111", identityKey: "0xabc" };

const raw = () => (db() as unknown as { $client: { prepare(s: string): { all(): unknown[]; run(...a: unknown[]): unknown } } }).$client;
const outboxRows = () => raw().prepare("SELECT kind, id, force, attempts FROM arkiv_outbox ORDER BY kind, id").all() as { kind: string; id: string; force: number; attempts: number }[];

describe("arkiv", () => {
  beforeEach(() => {
    freshFixtureDb();
  });

  it("is always stub under the test runner, and the stub board reads SQLite", async () => {
    expect(isArkivLive()).toBe(false);
    const r = await listCastlesWithMeta();
    expect(r.meta.source).toBe("sqlite");
    expect(r.castles.every((c) => c.vaultState === "guarding")).toBe(true);
    const all = await listCastlesWithMeta({}, { allStates: true });
    expect(all.castles.length).toBe(listCastles().length);
  });

  it("a castle is a Castellan-owned listing plus an arena-owned state; neither carries orders", () => {
    const s = schemas();
    expect(Object.keys(s)).toEqual(["castle", "castleState", "siege", "guardianProfile", "raiderProfile"]);
    const c = getCastle("castle_iron_warden")!;
    const identity = castleIdentityValues(c);
    const state = castleStateValues(c, link);
    expect(Object.keys(identity)).not.toContain("pot"); // nothing that moves is on the listing
    for (const v of [identity, state]) expect(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x))).not.toMatch(/orders/i);
    expect(state.identityKey.value).toBe("0xabc");
    expect(state.castellan.value).toBe(link.castellan);
  });

  it("the Castellan's wallet is the EVM address of the Hedera account that owns the vault", async () => {
    const c = getCastle("castle_iron_warden")!;
    const a = await castellanWallet(c);
    expect(a).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(await castellanWallet(c)).toBe(a); // deterministic
    expect(await castellanWallet(getCastle("castle_splinter_gate")!)).not.toBe(a);
  });

  it("castle state values round-trip through a query row", () => {
    for (const c of listCastles()) {
      const back = rowToCastle(asRow(castleStateValues(c, link)));
      const { arkiv, ...plain } = back;
      expect({ ...plain, createdAt: undefined }).toEqual({ ...c, createdAt: undefined });
      expect(Date.parse(back.createdAt)).toBe(Date.parse(c.createdAt));
      expect(arkiv).toEqual({ identityKey: "0xabc", castellan: link.castellan });
    }
  });

  it("siege and profile values round-trip (sieges without messages)", async () => {
    const s = await siege.start({ castleId: "castle_splinter_gate", raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
    const back = rowToSiege(asRow(siegeValues(s, "swarm-stub:abc")));
    expect(back).toMatchObject({ id: s.id, castleId: s.castleId, raider: "0.0.r", status: s.status, free: true, transport: s.transport, messages: [], swarmRef: "swarm-stub:abc" });
    const p = { wallet: "0.0.w", kind: "raider" as const, sieges: 4, breaks: 1, streak: 1, earned: "500000000" };
    expect(rowToProfile(asRow(profileValues(p)), "raider")).toEqual(p);
  });

  it("fingerprints ignore key order and change when a value changes", () => {
    const c = getCastle("castle_granite_hold")!;
    const a = castleStateValues(c, link) as Record<string, { type: string; value: unknown }>;
    const reversed = Object.fromEntries(Object.entries(a).reverse());
    expect(fingerprint(reversed)).toBe(fingerprint(a));
    expect(payloadFingerprint({ kind: "castle", data: { ...c, pot: "1" } })).not.toBe(payloadFingerprint({ kind: "castle", data: c }));
  });

  it("the outbox coalesces writes per entity and skips values Arkiv already holds", () => {
    const c = getCastle("castle_granite_hold")!;
    expect(enqueue({ kind: "castle", data: c }).queued).toBe(true);
    expect(enqueue({ kind: "castle", data: { ...c, pot: "2100000000" } }).queued).toBe(true);
    expect(outboxRows().filter((r) => r.id === c.id)).toHaveLength(1);
    expect(outboxStats().pending).toBe(1);

    // Pretend the drainer published exactly these values (the state entity is what changes).
    const fp = payloadFingerprint({ kind: "castle", data: c });
    raw()
      .prepare("INSERT INTO arkiv_entities (kind, id, key, fingerprint, expires_at_ms, updated_at) VALUES ('castleState', ?, '0xabc', ?, ?, 'now')")
      .run(c.id, fp, Date.now() + 60_000);
    expect(entityRecord("castleState", c.id)?.key).toBe("0xabc");
    expect(enqueue({ kind: "castle", data: c })).toEqual({ queued: false, key: "0xabc" });
    expect(enqueue({ kind: "castle", data: c }, { force: true }).queued).toBe(true);
  });

  it("a delisted castle is never queued again", () => {
    const c = getCastle("castle_granite_hold")!;
    outboxStats(); // creates the outbox tables
    raw().prepare("INSERT INTO arkiv_meta (k, v) VALUES (?, ?)").run(`delisted:${c.id}`, "2026-11-06T00:00:00Z");
    expect(enqueue({ kind: "castle", data: c })).toEqual({ queued: false });
  });

  it("reconcile queues every castle and Castellan once, then nothing until something changes", async () => {
    const first = reconcile();
    expect(first.castles).toBe(listCastles().length);
    expect(first.profiles).toBeGreaterThan(0);
    const before = outboxRows().length;
    reconcile();
    expect(outboxRows().length).toBe(before);

    const s = await siege.start({ castleId: "castle_splinter_gate", raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
    reconcile();
    expect(outboxRows().some((r) => r.kind === "siege" && r.id === s.id)).toBe(true);
  });

  it("describes the board query the way it runs", () => {
    expect(describeCastleQuery()).toBe('castleState WHERE vaultState = "guarding" ORDER BY pot DESC');
    expect(describeCastleQuery({ tier: "stone", sort: "streak" })).toBe('castleState WHERE tier = "stone" AND vaultState = "guarding" ORDER BY streak DESC');
    expect(describeCastleQuery({}, { allStates: true })).toBe("castleState ORDER BY pot DESC");
  });
});
