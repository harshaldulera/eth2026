import { beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { SDK_FIXTURE_CASTLE, sdkFixtureCastleRow } from "@/lib/fixtures/castles";
import { enqueueTurn, getTurn, TURN_STALE_MS } from "@/lib/guard/turns";
import { siege } from "@/lib/siege";
import type { PaidReceipt } from "@/lib/types";
import { guardTick } from "./guard";

/** Part 2a worker/guard.ts: stale turns expire, a silent harness goes dormant (ops voided), drift closes. */

const SDK = SDK_FIXTURE_CASTLE.id;
const paid = (): Omit<PaidReceipt, "siegeId"> => ({ free: false, txId: `stub:x402@${Date.now()}`, payer: "0.0.raider", amount: "100000000", asset: "0.0.0", network: "hedera:testnet", hashscanUrl: "#stub", stub: true });
const row = () => db().select().from(schema.castles).where(eq(schema.castles.id, SDK)).get()!;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe("guardTick", () => {
  beforeEach(() => {
    freshFixtureDb();
    db().insert(schema.castles).values({ ...sdkFixtureCastleRow({ vaultId: 7 }), leaseId: "lease-AAAA", lastSeenAt: ago(1000) }).run();
  });

  it("leaves a live harness and a no-lease fixture alone", async () => {
    expect(await guardTick()).toMatchObject({ dormant: [], guarding: [], closed: [] });
    db().update(schema.castles).set({ leaseId: null, lastSeenAt: null }).where(eq(schema.castles.id, SDK)).run();
    expect(await guardTick()).toMatchObject({ dormant: [] });
    expect(row().vaultState).toBe("guarding");
  });

  it("a harness silent for 30 s → dormant; its in-flight op is voided and refunded", async () => {
    const s = await siege.start({ castleId: SDK, raider: "0.0.raider", receipt: paid() });
    db().update(schema.castles).set({ lastSeenAt: ago(31_000) }).where(eq(schema.castles.id, SDK)).run();
    const r = await guardTick();
    expect(r.dormant).toEqual([SDK]);
    expect(row()).toMatchObject({ vaultState: "dormant", status: "open" });
    expect(row().vaultStateReason).toMatch(/offline/);
    const sg = db().select().from(schema.sieges).where(eq(schema.sieges.id, s.id)).get()!;
    expect(sg.voidReason).toBe("guardian_dormant");
    // polling again (fresh last_seen_at) → guarding on the next pass
    db().update(schema.castles).set({ lastSeenAt: ago(500) }).where(eq(schema.castles.id, SDK)).run();
    expect((await guardTick()).guarding).toEqual([SDK]);
    expect(row().vaultState).toBe("guarding");
  });

  it("a funded vault whose harness is polling → guarding", async () => {
    db().update(schema.castles).set({ vaultState: "funded" }).where(eq(schema.castles.id, SDK)).run();
    expect((await guardTick()).guarding).toEqual([SDK]);
  });

  it("prompt drift on a live vault → closed with orders_changed", async () => {
    db().update(schema.castles).set({ pinnedPromptHash: "a".repeat(64), promptDriftHash: "b".repeat(64) }).where(eq(schema.castles.id, SDK)).run();
    const r = await guardTick();
    expect(r.closed).toEqual([SDK]);
    expect(row()).toMatchObject({ vaultState: "closed", status: "closed", vaultStateReason: "orders_changed" });
    expect((await guardTick()).closed).toEqual([]);
  });

  it("expires stale guard turns", async () => {
    const id = enqueueTurn({ castleId: SDK, kind: "siege", siegeId: "s", turn: 1, messages: [] });
    db().update(schema.guardTurns).set({ createdAt: ago(TURN_STALE_MS + 1000) }).where(eq(schema.guardTurns.id, id)).run();
    expect((await guardTick()).expired).toBe(1);
    expect(getTurn(id)!.state).toBe("expired");
  });
});
