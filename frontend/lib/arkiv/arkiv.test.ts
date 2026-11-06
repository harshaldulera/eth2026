import { beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { db } from "@/lib/db";
import { getCastle, listCastles } from "@/lib/castles";
import { siege } from "@/lib/siege";
import { castleValues, fingerprint, profileValues, rowToCastle, rowToProfile, rowToSiege, siegeValues } from "./codec";
import { describeCastleQuery } from "./queries";
import { enqueue, entityRecord, outboxStats, payloadFingerprint } from "./outbox";
import { reconcile } from "./reconcile";
import { schemas } from "./schema";
import { isArkivLive, listCastlesWithMeta } from ".";

/** A query row as the SDK returns it: every column as { type, value }. */
const asRow = (values: Record<string, { type: string; value: unknown }>) => values as unknown as Record<string, unknown>;

const outboxRows = () =>
  (db() as unknown as { $client: { prepare(s: string): { all(): unknown[] } } }).$client
    .prepare("SELECT kind, id, force, attempts FROM arkiv_outbox ORDER BY kind, id")
    .all() as { kind: string; id: string; force: number; attempts: number }[];

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

  it("schemas are namespaced and never carry orders", () => {
    const s = schemas();
    expect(Object.keys(s)).toEqual(["castle", "siege", "guardianProfile", "raiderProfile"]);
    const values = castleValues(getCastle("castle_iron_warden")!);
    expect(Object.keys(values)).not.toContain("orders");
    expect(JSON.stringify(values, (_, v) => (typeof v === "bigint" ? v.toString() : v))).not.toMatch(/orders/i);
  });

  it("castle values round-trip through a query row", () => {
    for (const c of listCastles()) {
      const back = rowToCastle(asRow(castleValues(c)));
      // createdAt is stored at ms precision; everything else is exact.
      expect({ ...back, createdAt: undefined }).toEqual({ ...c, createdAt: undefined });
      expect(Date.parse(back.createdAt)).toBe(Date.parse(c.createdAt));
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
    const a = castleValues(c) as Record<string, { type: string; value: unknown }>;
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

    // Pretend the drainer published exactly these values.
    const fp = payloadFingerprint({ kind: "castle", data: c });
    (db() as unknown as { $client: { prepare(s: string): { run(...a: unknown[]): unknown } } }).$client
      .prepare("INSERT INTO arkiv_entities (kind, id, key, fingerprint, expires_at_ms, updated_at) VALUES ('castle', ?, '0xabc', ?, ?, 'now')")
      .run(c.id, fp, Date.now() + 60_000);
    expect(entityRecord("castle", c.id)?.key).toBe("0xabc");
    expect(enqueue({ kind: "castle", data: c })).toEqual({ queued: false, key: "0xabc" });
    expect(enqueue({ kind: "castle", data: c }, { force: true }).queued).toBe(true);
  });

  it("reconcile queues every castle and Castellan once, then nothing until something changes", async () => {
    const first = reconcile();
    expect(first.castles).toBe(listCastles().length);
    expect(first.profiles).toBeGreaterThan(0);
    // Queued but unsent: re-queuing the same values replaces the row, it does not add one.
    const before = outboxRows().length;
    reconcile();
    expect(outboxRows().length).toBe(before);

    const s = await siege.start({ castleId: "castle_splinter_gate", raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
    reconcile();
    expect(outboxRows().some((r) => r.kind === "siege" && r.id === s.id)).toBe(true);
  });

  it("describes the board query the way it runs", () => {
    expect(describeCastleQuery()).toBe('castle WHERE vaultState = "guarding" ORDER BY pot DESC');
    expect(describeCastleQuery({ tier: "stone", sort: "streak" })).toBe('castle WHERE tier = "stone" AND vaultState = "guarding" ORDER BY streak DESC');
    expect(describeCastleQuery({}, { allStates: true })).toBe("castle ORDER BY pot DESC");
  });
});
