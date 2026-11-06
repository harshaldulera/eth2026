import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { sdkFixtureCastleRow } from "@/lib/fixtures/castles";
import { leaseLive, LEASE_TTL_MS, readLeaseId, sdkStatusOf, touchLease } from "./lease";
import {
  answerTurn,
  awaitAnswer,
  claimNext,
  enqueueTurn,
  expireStale,
  getTurn,
  GuardTimeoutError,
  handOverTurns,
  toPayload,
  TURN_STALE_MS,
} from "./turns";

const CASTLE = "castle_refund_desk";
const msgs = [{ role: "user" as const, content: "hello" }];

describe("guard_turns queue", () => {
  beforeEach(() => {
    freshFixtureDb();
    db().insert(schema.castles).values(sdkFixtureCastleRow()).run();
  });

  it("claims the oldest pending turn once, for one lease; the payload carries only the turn", () => {
    const a = enqueueTurn({ castleId: CASTLE, kind: "siege", siegeId: "siege_1", turn: 1, messages: msgs });
    const b = enqueueTurn({ castleId: CASTLE, kind: "siege", siegeId: "siege_1", turn: 2, messages: msgs });
    enqueueTurn({ castleId: "castle_other", kind: "siege", siegeId: "siege_x", turn: 1, messages: msgs });
    const first = claimNext(CASTLE, "lease-A")!;
    expect(first.id).toBe(a);
    expect(first).toMatchObject({ state: "claimed", leaseId: "lease-A" });
    expect(toPayload(first)).toEqual({ turnId: a, kind: "siege", siegeId: "siege_1", turn: 1, messages: msgs });
    expect(claimNext(CASTLE, "lease-B")!.id).toBe(b);
    expect(claimNext(CASTLE, "lease-A")).toBeNull();
  });

  it("atomicity: many concurrent claimers never share a turn", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => enqueueTurn({ castleId: CASTLE, kind: "siege", siegeId: "s", turn: i + 1, messages: msgs }));
    const got = await Promise.all(Array.from({ length: 25 }, (_, i) => Promise.resolve().then(() => claimNext(CASTLE, `lease-${i % 3}`))));
    const claimed = got.filter(Boolean).map((r) => r!.id);
    expect(claimed.sort()).toEqual([...ids].sort());
    expect(new Set(claimed).size).toBe(10);
  });

  it("answerTurn: only the claiming lease answers; expired and unknown turns are reported", () => {
    const id = enqueueTurn({ castleId: CASTLE, kind: "siege", siegeId: "s", turn: 1, messages: msgs });
    expect(answerTurn(id, "lease-A", { reply: "no", toolCalls: [] })).toBe("not_claimed_by_you"); // still pending
    claimNext(CASTLE, "lease-A");
    expect(answerTurn(id, "lease-B", { reply: "no", toolCalls: [] })).toBe("not_claimed_by_you");
    expect(answerTurn(id, "lease-A", { reply: "no", toolCalls: [] })).toBe("ok");
    expect(answerTurn(id, "lease-A", { reply: "again", toolCalls: [] })).toBe("not_claimed_by_you");
    expect(answerTurn("gt_nope", "lease-A", { reply: "x", toolCalls: [] })).toBe("not_found");
    const late = enqueueTurn({ castleId: CASTLE, kind: "siege", siegeId: "s", turn: 2, messages: msgs });
    claimNext(CASTLE, "lease-A");
    db().update(schema.guardTurns).set({ state: "expired" }).where(eq(schema.guardTurns.id, late)).run();
    expect(answerTurn(late, "lease-A", { reply: "x", toolCalls: [] })).toBe("expired");
  });

  it("awaitAnswer returns the harness's reply", async () => {
    const id = enqueueTurn({ castleId: CASTLE, kind: "siege", siegeId: "s", turn: 1, messages: msgs });
    setTimeout(() => {
      claimNext(CASTLE, "lease-A");
      answerTurn(id, "lease-A", { reply: "I can't do that", toolCalls: [{ name: "lookup_order", args: { id: 1 } }] });
    }, 30);
    await expect(awaitAnswer(id, { timeoutMs: 2000, pollMs: 10 })).resolves.toEqual({ reply: "I can't do that", toolCalls: [{ name: "lookup_order", args: { id: 1 } }] });
  });

  it("awaitAnswer times out: the turn is expired and a late answer is refused", async () => {
    const id = enqueueTurn({ castleId: CASTLE, kind: "siege", siegeId: "s", turn: 1, messages: msgs });
    claimNext(CASTLE, "lease-A");
    await expect(awaitAnswer(id, { timeoutMs: 50, pollMs: 10 })).rejects.toBeInstanceOf(GuardTimeoutError);
    expect(getTurn(id)!.state).toBe("expired");
    expect(answerTurn(id, "lease-A", { reply: "late", toolCalls: [] })).toBe("expired");
  });

  it("awaitAnswer stops early when stop() returns an error", async () => {
    const id = enqueueTurn({ castleId: CASTLE, kind: "siege", siegeId: "s", turn: 1, messages: msgs });
    const boom = new Error("dormant");
    await expect(awaitAnswer(id, { timeoutMs: 5000, pollMs: 10, stop: () => boom })).rejects.toBe(boom);
    expect(getTurn(id)!.state).toBe("expired");
  });

  it("expireStale expires old pending and old claimed turns only", () => {
    const old = enqueueTurn({ castleId: CASTLE, kind: "siege", siegeId: "s", turn: 1, messages: msgs });
    const fresh = enqueueTurn({ castleId: CASTLE, kind: "siege", siegeId: "s", turn: 2, messages: msgs });
    const past = new Date(Date.now() - TURN_STALE_MS - 1000).toISOString();
    db().update(schema.guardTurns).set({ createdAt: past }).where(eq(schema.guardTurns.id, old)).run();
    expect(expireStale()).toBe(1);
    expect(getTurn(old)!.state).toBe("expired");
    expect(getTurn(fresh)!.state).toBe("pending");
    claimNext(CASTLE, "lease-A");
    db().update(schema.guardTurns).set({ claimedAt: past }).where(eq(schema.guardTurns.id, fresh)).run();
    expect(expireStale()).toBe(1);
    expect(getTurn(fresh)!.state).toBe("expired");
  });

  it("handOverTurns: the old lease's claimed siege turns go back to pending, check turns expire", () => {
    const s = enqueueTurn({ castleId: CASTLE, kind: "siege", siegeId: "s", turn: 1, messages: msgs });
    const c = enqueueTurn({ castleId: CASTLE, kind: "selfcheck", siegeId: "selfcheck_x", turn: 1, messages: msgs });
    claimNext(CASTLE, "lease-A");
    handOverTurns(CASTLE, "lease-A");
    expect(getTurn(s)).toMatchObject({ state: "pending", leaseId: null });
    expect(getTurn(c)!.state).toBe("expired");
  });
});

describe("guard leases", () => {
  beforeEach(() => {
    freshFixtureDb();
    db().insert(schema.castles).values(sdkFixtureCastleRow()).run();
  });

  const row = () => db().select().from(schema.castles).where(eq(schema.castles.id, CASTLE)).get()!;

  it("readLeaseId accepts only sane ids", () => {
    expect(readLeaseId("lease-1234")).toBe("lease-1234");
    expect(readLeaseId(" 0b7c2f6e-1d2a-4c55-9a51-8f1b6f2f9a10 ")).toBe("0b7c2f6e-1d2a-4c55-9a51-8f1b6f2f9a10");
    for (const bad of [null, "", "short", "has space here", "x".repeat(200), "semi;colon12"]) expect(readLeaseId(bad)).toBeNull();
  });

  it("newest lease wins; the retired one is lease_lost; a new lease resets the checks", () => {
    db().update(schema.castles).set({ selfCheckAt: "2026-01-01T00:00:00.000Z", smokeResult: '{"ok":true,"at":"x"}' }).where(eq(schema.castles.id, CASTLE)).run();
    expect(touchLease(CASTLE, "lease-AAAA", { sdk: "0.1.0" })).toEqual({ ok: true, status: "new", leaseId: "lease-AAAA", previous: null });
    expect(row()).toMatchObject({ leaseId: "lease-AAAA", selfCheckAt: null, smokeResult: null });
    expect(JSON.parse(row().leaseMeta!)).toMatchObject({ sdk: "0.1.0", retired: [] });
    expect(touchLease(CASTLE, "lease-AAAA")).toMatchObject({ ok: true, status: "same" });
    expect(touchLease(CASTLE, "lease-BBBB")).toMatchObject({ ok: true, status: "new", previous: "lease-AAAA" });
    expect(touchLease(CASTLE, "lease-AAAA")).toEqual({ ok: false, reason: "lease_lost" });
    expect(row().leaseId).toBe("lease-BBBB");
  });

  it("leaseLive and Castle.sdk use server timestamps; no secrets in Castle.sdk", () => {
    const now = Date.now();
    expect(leaseLive({ leaseId: null, lastSeenAt: new Date(now).toISOString() }, now)).toBe(false);
    expect(leaseLive({ leaseId: "l", lastSeenAt: new Date(now - LEASE_TTL_MS + 1000).toISOString() }, now)).toBe(true);
    expect(leaseLive({ leaseId: "l", lastSeenAt: new Date(now - LEASE_TTL_MS - 1).toISOString() }, now)).toBe(false);
    touchLease(CASTLE, "lease-AAAA");
    const s = sdkStatusOf({ ...row(), pinnedPromptHash: "abc", selfCheckAt: "t", leaseMeta: JSON.stringify({ tools: ["issue_refund"], smoke: { siegeId: "smoke_x", held: 2 } }) });
    expect(s).toEqual({ leaseLive: true, promptPinned: true, selfCheckAt: "t", smokeHeld: 2 });
  });
});
