/**
 * The HCS audit trail of a castle is strictly ordered: full sieges through the real route handlers +
 * worker passes, then the audit drainer. The topic must read start, message 1..n, end, then what the
 * worker settled (siege.attempt / vault.release, then vault.state "broken"), in that order.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { and, asc, eq } from "drizzle-orm";
import { keccak256, stringToBytes } from "viem";
import { resetEnv } from "@/lib/config/env";
import { auditTrail, chain } from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { emit } from "@/lib/events/bus";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { MUST_NOT_BREAK, WOODEN_BREAK } from "@/lib/fixtures/raids";
import { STUB_PAYMENT_HEADER } from "@/lib/pay";
import { getSiege } from "@/lib/siege";
import type { Siege } from "@/lib/types";
import { auditTick } from "./audit";
import { createInProcessFetch } from "./dispatch";
import { setFetch } from "./fetch";
import { setWorkerQuiet } from "./log";
import { settleTick } from "./settle";
import { tick } from "./tick";

setWorkerQuiet(true);
const BASE = "http://localhost:3000";
const f = createInProcessFetch(BASE);
const WOOD = "castle_splinter_gate";
const GRANITE = "castle_granite_hold";
const L = schema.auditLog;

async function call<T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await f(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as T };
}

async function paidSiege(castleId: string, raider: string): Promise<string> {
  const r = await call<{ siegeId: string }>("POST", "/api/siege/start", { castleId }, { [STUB_PAYMENT_HEADER]: raider });
  expect(r.status).toBe(200);
  return r.data.siegeId;
}
const say = (siegeId: string, text: string) => call<{ siege: Siege }>("POST", `/api/siege/${siegeId}/message`, { text });

/** The castle's topic, in local (= submission) order. */
const topicRows = (castleId: string) => db().select().from(L).where(eq(L.castleId, castleId)).orderBy(asc(L.localSeq)).all();
const msg = (r: { message: string }) => JSON.parse(r.message) as Record<string, unknown>;

beforeEach(() => {
  process.env.CHAIN_MODE = "stub";
  freshFixtureDb();
  resetEnv();
  setFetch(f);
});
afterAll(() => setFetch(null));

describe("HCS audit order", () => {
  it("a break: start, message 1..3, end, vault.release, vault.state broken — HCS seq follows the same order", async () => {
    const a = await paidSiege(WOOD, "0.0.stub-a");
    // A held siege on another castle runs interleaved: its topic is separate and must not disturb this one.
    const h = await paidSiege(GRANITE, "0.0.stub-h");
    for (let i = 0; i < WOODEN_BREAK.length; i++) {
      await say(a, WOODEN_BREAK[i]);
      await say(h, MUST_NOT_BREAK[i]);
      await auditTick(); // drain mid-siege too: earlier turns go out while later ones are still being played
    }
    for (const t of MUST_NOT_BREAK.slice(WOODEN_BREAK.length)) await say(h, t);
    expect(getSiege(a)!.status).toBe("broken");
    expect(getSiege(h)!.status).toBe("held");
    await settleTick();
    expect(getSiege(a)!.release?.txId).toBeTruthy();
    await auditTick();

    const rows = topicRows(WOOD);
    expect(rows.every((r) => r.state === "submitted")).toBe(true);
    // HCS sequence numbers are exactly the local order.
    expect(rows.map((r) => r.seq)).toEqual(rows.map((r) => r.localSeq));
    expect(rows.map((r) => r.localSeq)).toEqual(rows.map((_, i) => i + 1));

    const mine = rows.filter((r) => r.siegeId === a || (r.type === "vault.state" && msg(r).to === "broken"));
    expect(mine.map((r) => r.type)).toEqual([
      "siege.start",
      "siege.message",
      "siege.message",
      "siege.message",
      "siege.end",
      "vault.release",
      "vault.state",
    ]);
    const msgs = mine.map(msg);
    expect(msgs.slice(1, 4).map((m) => m.turn)).toEqual([1, 2, 3]);
    // The exact plan A4 payloads: the hash of the text (never the text), the transport, the proxy request id.
    for (let i = 0; i < 3; i++) {
      expect(msgs[1 + i]).toMatchObject({ v: 1, type: "siege.message", siegeId: a, castleId: WOOD, transport: "hosted", hash: keccak256(stringToBytes(WOODEN_BREAK[i])) });
      expect(typeof msgs[1 + i].requestId).toBe("string");
      expect(mine[1 + i].message).not.toContain("Lord Commander");
    }
    expect(msgs[0]).toMatchObject({ type: "siege.start", siegeId: a, transport: "hosted" });
    expect(String(msgs[0].txId)).toMatch(/^stub:/);
    expect(msgs[4]).toMatchObject({ type: "siege.end", turn: 3, result: "broken", hash: getSiege(a)!.transcriptHash, requestId: msgs[3].requestId });
    expect(msgs[5]).toMatchObject({ type: "vault.release", txId: getSiege(a)!.release!.txId });
    for (const r of rows) expect(Buffer.byteLength(r.message)).toBeLessThanOrEqual(1000);

    // The held siege on Granite Hold: start, 5 messages, end, attempt, on its own topic.
    const held = topicRows(GRANITE).filter((r) => r.siegeId === h);
    expect(held.map((r) => r.type)).toEqual(["siege.start", ...Array(5).fill("siege.message"), "siege.end", "siege.attempt"]);
    expect(held.map((r) => msg(r).turn ?? null)).toEqual([null, 1, 2, 3, 4, 5, 5, null]);
    expect(held.every((r) => r.state === "submitted" && r.topicId === held[0].topicId && r.topicId !== rows[0].topicId)).toBe(true);
  });

  it("each siege event is audited once, however many passes and appends run", async () => {
    const a = await paidSiege(WOOD, "0.0.stub-a");
    await say(a, WOODEN_BREAK[0]);
    await auditTick();
    await auditTick();
    await chain.audit({ siegeId: "", castleId: WOOD, type: "vault_state", payload: { from: "guarding", to: "guarding", reason: "noop" }, at: new Date().toISOString() });
    await tick();
    const rows = topicRows(WOOD).filter((r) => r.siegeId === a);
    expect(rows.map((r) => r.type)).toEqual(["siege.start", "siege.message"]);
    expect(new Set(rows.map((r) => r.eventId)).size).toBe(2);
  });

  it("an append catches up on persisted siege events first: siege.end always precedes the attempt that follows it", async () => {
    const a = await paidSiege(WOOD, "0.0.stub-a");
    // The engine persisted the end event; nobody has drained since. The worker's audit lands after it.
    emit({ siegeId: a, castleId: WOOD, type: "end", turn: 5, transport: "hosted", payload: { status: "held", transcriptHash: `0x${"ab".repeat(32)}` } });
    const r = await chain.audit({ siegeId: a, castleId: WOOD, type: "attempt", transport: "hosted", payload: { txId: "stub:x" }, at: new Date().toISOString() });
    expect(r.ok).toBe(true);
    expect(topicRows(WOOD).filter((x) => x.siegeId === a).map((x) => x.type)).toEqual(["siege.start", "siege.end", "siege.attempt"]);
  });

  it("the worker waits for a paid siege's end event before settling it (the engine commits the status a moment earlier)", async () => {
    const a = await paidSiege(WOOD, "0.0.stub-a");
    for (const t of WOODEN_BREAK) await say(a, t);
    // Simulate the window: the end event is not persisted yet.
    const ends = db().select().from(schema.events).where(and(eq(schema.events.siegeId, a), eq(schema.events.type, "end"))).all();
    expect(ends).toHaveLength(1);
    db().delete(schema.events).where(eq(schema.events.id, ends[0].id)).run();
    await settleTick();
    expect(getSiege(a)!.release).toBeUndefined();
    const { id: _id, ...end } = ends[0];
    void _id;
    db().insert(schema.events).values(end).run();
    await settleTick();
    expect(getSiege(a)!.release?.txId).toBeTruthy();
  });

  it("auditTrail / GET /api/castles/[id]: pending until drained, then the HCS seq", async () => {
    const a = await paidSiege(WOOD, "0.0.stub-a");
    await say(a, WOODEN_BREAK[0]);
    // Nothing derived yet: the siege's events are not in the trail until the drainer (or an append) picks them up.
    await chain.audit({ siegeId: "", castleId: WOOD, type: "vault_state", payload: { from: "guarding", to: "guarding", reason: "x" }, at: new Date().toISOString() });
    const before = auditTrail(WOOD);
    expect(before.messages.length).toBe(3);
    expect(before.messages.every((m) => m.state === "pending" && m.seq === null && m.txId === undefined)).toBe(true);
    expect(before.messages.map((m) => m.type)).toEqual(["vault.state", "siege.message", "siege.start"]); // newest first
    await auditTick();
    const res = await call<{ audit: ReturnType<typeof auditTrail> }>("GET", `/api/castles/${WOOD}`);
    expect(res.status).toBe(200);
    expect(res.data.audit.topicId).toBe(`0.0.stub-${WOOD}`);
    expect(res.data.audit.messages.map((m) => [m.state, m.seq, m.localSeq])).toEqual([
      ["submitted", 3, 3],
      ["submitted", 2, 2],
      ["submitted", 1, 1],
    ]);
  });
});
