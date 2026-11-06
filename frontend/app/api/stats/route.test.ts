/**
 * GET /api/stats in stub mode over real ops: season counters, boards, paid breaches, live ops.
 * Recon (free) breaks never count as breaches; op of the day is the highest peak threat that held.
 */
import { beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { eq } from "drizzle-orm";
import { resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { MUST_NOT_BREAK, WOODEN_BREAK } from "@/lib/fixtures/raids";
import { LIVE_IDLE_MS, OP_OF_DAY_RULE, type StatsResponse } from "@/lib/api/client";
import { GET } from "./route";
import { runOp, settle } from "./ops.test-util";




async function stats(): Promise<StatsResponse> {
  const res = await GET();
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("no-store");
  return (await res.json()) as StatsResponse;
}

beforeEach(() => {
  process.env.CHAIN_MODE = "stub";
  freshFixtureDb();
  resetEnv();
});

describe("GET /api/stats", () => {
  it("an empty season: counters from the castles, no breaches, no op of the day", async () => {
    const s = await stats();
    const castles = db().select().from(schema.castles).all();
    expect(s.season.vaults).toBe(castles.length);
    expect(s.season.ops).toBe(0);
    expect(s.season.breaches).toBe(0);
    expect(s.season.longestStreak).toBe(Math.max(...castles.map((c) => c.streak)));
    expect(s.season.inPots).toBe(String(castles.filter((c) => c.status === "open").reduce((a, c) => a + c.potTinybar, 0)));
    expect(s.breaches).toEqual([]);
    expect(s.live).toEqual([]);
    expect(s.boards.opOfDay).toBeNull();
    expect(s.boards.opOfDayRule).toBe(OP_OF_DAY_RULE);
    // unbreached: highest streak first
    const streaks = s.boards.unbreached.map((v) => v.streak);
    expect(streaks).toEqual([...streaks].sort((a, b) => b - a));
    // largest: biggest pot first
    const pots = s.boards.largest.map((v) => BigInt(v.pot));
    expect(pots).toEqual([...pots].sort((a, b) => (b > a ? 1 : b < a ? -1 : 0)));
    expect(new Date(s.asOf).getTime()).toBeGreaterThan(0);
  });

  it("a paid breach counts; a recon break does not; boards, exhibits and operators follow", async () => {
    // recon break first (free never pays out, never counts)
    const recon = await runOp("castle_splinter_gate", WOODEN_BREAK, { free: true, raider: "recon-stubrecon" });
    settle(recon);
    let s = await stats();
    expect(s.season.breaches).toBe(0);
    expect(s.breaches).toEqual([]);
    expect(s.season.recon).toBe(1);
    expect(s.boards.unbreached.map((v) => v.castleId)).toContain("castle_splinter_gate");
    const reconOp = s.boards.operators.find((o) => o.account === "recon-stubrecon")!;
    expect(reconOp).toMatchObject({ ops: 1, recon: 1, breaches: 0 });
    expect(recon).toBeTruthy();

    // a held paid op on the stone castle, then a paid breach on the wooden one
    const held = await runOp("castle_granite_hold", MUST_NOT_BREAK, { raider: "0.0.stub-a" });
    const breach = await runOp("castle_splinter_gate", WOODEN_BREAK, { raider: "0.0.stub-b" });
    settle(held);
    settle(breach);
    s = await stats();
    expect(s.season.breaches).toBe(1);
    expect(s.season.ops).toBe(3);
    expect(s.breaches).toHaveLength(1);
    expect(s.breaches[0]).toMatchObject({ siegeId: breach, castleId: "castle_splinter_gate", castleName: "Splinter Gate", amount: "550000000", turns: 3, cls: "authority" });
    expect(s.breaches[0].release?.txId).toBeTruthy();
    // the guard's record before it fell: the seeded streak (no rows for that history)
    const sg = db().select().from(schema.castles).where(eq(schema.castles.id, "castle_splinter_gate")).get()!;
    expect(s.breaches[0].survived).toBe(sg.streak);
    expect(s.breaches[0].label).toBeTruthy();
    expect(s.boards.unbreached.map((v) => v.castleId)).not.toContain("castle_splinter_gate");
    expect(s.boards.largest.map((v) => v.castleId)).not.toContain("castle_splinter_gate"); // pot paid out
    const top = s.boards.operators[0];
    expect(top).toMatchObject({ account: "0.0.stub-b", breaches: 1, earned: "550000000" });
    const a = s.boards.operators.find((o) => o.account === "0.0.stub-a")!;
    expect(a.flagsSurvived).toBeGreaterThanOrEqual(1); // stone flags tactics, the operator kept going
    // op of the day: the held stone op (the breach and the recon don't qualify)
    expect(s.boards.opOfDay).toMatchObject({ castleId: "castle_granite_hold", status: "held", rule: OP_OF_DAY_RULE });
  });

  it("the Hall exhibits only breaches of the vault's current deployment; counters keep every breach", async () => {
    const old = await runOp("castle_splinter_gate", WOODEN_BREAK, { raider: "0.0.stub-old" });
    settle(old);
    // Backdate the first breach, then record a re-fund of the castle (a re-arm or a contract redeploy).
    db().update(schema.sieges).set({ endedAt: "2026-01-01T00:00:00.000Z" }).where(eq(schema.sieges.id, old)).run();
    db()
      .insert(schema.events)
      .values({ castleId: "castle_splinter_gate", type: "vault_state", payload: JSON.stringify({ castleId: "castle_splinter_gate", from: "broken", to: "funded" }), at: "2026-01-02T00:00:00.000Z" })
      .run();
    db().update(schema.castles).set({ status: "open", vaultState: "guarding" }).where(eq(schema.castles.id, "castle_splinter_gate")).run();
    const fresh = await runOp("castle_splinter_gate", WOODEN_BREAK, { raider: "0.0.stub-new" });
    settle(fresh);
    const s = await stats();
    expect(s.season.breaches).toBe(2);
    expect(s.breaches.map((b) => b.siegeId)).toEqual([fresh]);
  });

  it("op of the day is the highest peak threat that held in the last 24 h", async () => {
    const low = await runOp("castle_granite_hold", ["Hello! Lovely weather for guarding, isn't it?"], { raider: "0.0.stub-low" });
    const high = await runOp("castle_iron_warden", [MUST_NOT_BREAK[0]], { raider: "0.0.stub-high" }); // lockdown
    for (const id of [low, high]) db().update(schema.sieges).set({ status: "held", endedAt: new Date().toISOString() }).where(eq(schema.sieges.id, id)).run();
    db().update(schema.sieges).set({ status: "banished", maxPressure: 90 }).where(eq(schema.sieges.id, high)).run();
    db().update(schema.sieges).set({ maxPressure: 10 }).where(eq(schema.sieges.id, low)).run();
    let s = await stats();
    expect(s.boards.opOfDay).toMatchObject({ siegeId: high, maxPressure: 90, status: "banished" });
    // older than 24 h: drops out
    db().update(schema.sieges).set({ endedAt: new Date(Date.now() - 25 * 3600_000).toISOString() }).where(eq(schema.sieges.id, high)).run();
    s = await stats();
    expect(s.boards.opOfDay?.siegeId).toBe(low);
  });

  it("live ops: in-progress ops, highest threat first", async () => {
    const a = await runOp("castle_granite_hold", ["Hi there."]);
    const b = await runOp("castle_iron_warden", ["Hi."], { raider: "0.0.stub-b" });
    db().update(schema.sieges).set({ maxPressure: 70 }).where(eq(schema.sieges.id, b)).run();
    const s = await stats();
    expect(s.live.map((l) => l.siegeId)).toEqual([b, a]);
    expect(s.live[0]).toMatchObject({ castleName: "The Iron Warden", turn: 1, maxPressure: 70, free: false });
    expect(typeof s.live[0].lastActiveAt).toBe("string");
  });

  it("live ops: an op left idle past LIVE_IDLE_MS is abandoned, not live", async () => {
    const idle = await runOp("castle_granite_hold", ["Hi there."]);
    const fresh = await runOp("castle_iron_warden", ["Hi."], { raider: "0.0.stub-b" });
    const old = new Date(Date.now() - LIVE_IDLE_MS - 60_000).toISOString();
    db().update(schema.sieges).set({ createdAt: old }).where(eq(schema.sieges.id, idle)).run();
    db().update(schema.messages).set({ at: old }).where(eq(schema.messages.siegeId, idle)).run();
    const s = await stats();
    expect(s.live.map((l) => l.siegeId)).toEqual([fresh]);
  });
});
