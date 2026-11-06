/**
 * Replay: the full state matrix through the real paths.
 *  - paid sieges are bought through POST /api/siege/start (stub x402), played through the message
 *    route, settled by the worker's settleTick, and read through GET /api/replay/[id];
 *  - every check is driven to pass AND to fail;
 *  - the testnet mirror-node path runs against a mocked fetch.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
process.env.SIEGE_FAST = "1";
import { and, eq } from "drizzle-orm";
import { resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { drainAudit } from "@/lib/chain/outbox";
import { STUB_PAYMENT_HEADER } from "@/lib/pay";
import { siege } from "@/lib/siege";
import { replayHeadline } from "@/lib/siege/text";
import { MUST_NOT_BREAK, WOODEN_BREAK } from "@/lib/fixtures/raids";
import { SDK_FIXTURE_CASTLE, sdkFixtureCastleRow } from "@/lib/fixtures/castles";
import type { Siege } from "@/lib/types";
import { createInProcessFetch } from "@/worker/dispatch";
import { setFetch } from "@/worker/fetch";
import { settleTick } from "@/worker/settle";
import { setWorkerQuiet } from "@/worker/log";
import { buildReplay } from "./build";
import type { ReplayData } from "./types";

setWorkerQuiet(true);
const BASE = "http://localhost:3000";
const f = createInProcessFetch(BASE);
const WOOD = "castle_splinter_gate";
const GRANITE = "castle_granite_hold";

async function call<T>(method: "GET" | "POST", p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await f(`${BASE}${p}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: (await res.json().catch(() => null)) as T };
}
const paidSiege = async (castleId: string, raider: string) => {
  const r = await call<{ siegeId: string }>("POST", "/api/siege/start", { castleId }, { [STUB_PAYMENT_HEADER]: raider });
  expect(r.status).toBe(200);
  return r.data.siegeId;
};
const say = (id: string, text: string) => call<{ siege: Siege; error?: string }>("POST", `/api/siege/${id}/message`, { text });
async function sayAll(id: string, lines: readonly string[]) {
  for (const t of lines) {
    const r = await say(id, t);
    if (r.status !== 200 || r.data.siege.status !== "in_progress") return r;
  }
}
async function settle(times = 4) {
  for (let i = 0; i < times; i++) {
    await settleTick();
    await new Promise((r) => setTimeout(r, 2));
  }
  await drainAudit();
}
const replay = async (id: string) => {
  const r = await call<ReplayData>("GET", `/api/replay/${id}`);
  expect(r.status).toBe(200);
  return r.data;
};
const states = (r: ReplayData) => Object.fromEntries(r.checks.map((c) => [c.key, c.state]));
const check = (r: ReplayData | null, key: string) => r!.checks.find((c) => c.key === key);
const free = async (castleId: string, lines: readonly string[]) => {
  const s = await siege.start({ castleId, raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
  for (const t of lines) {
    const r = await siege.message(s.id, t);
    if (!r.ok || r.siege.status !== "in_progress") break;
  }
  await drainAudit();
  return s.id;
};

beforeEach(() => {
  process.env.CHAIN_MODE = "stub";
  delete process.env.OWNER_SECRET;
  freshFixtureDb();
  resetEnv();
  setFetch(f);
});
afterAll(() => setFetch(null));

describe("paid sieges, through the public route", () => {
  it("paid break: all seven checks pass, payout linked, not live", async () => {
    const id = await paidSiege(WOOD, "0.0.stub-a");
    await sayAll(id, WOODEN_BREAK);
    await settle();
    const r = await replay(id);
    expect(r.siege.status).toBe("broken");
    expect(r.siege.release).toBeTruthy();
    expect(states(r)).toEqual({ transcript: "pass", hash: "pass", "hcs-end": "pass", "hcs-messages": "pass", inference: "pass", verifier: "pass", payout: "pass" });
    expect(check(r, "payout")!.label).toBe("Vault paid out on Hedera");
    expect(r.hcs.entries.map((e) => e.type)).toEqual(["siege.start", "siege.message", "siege.message", "siege.message", "siege.end", "vault.release"]);
    expect(r.live).toBe(false);
    expect(replayHeadline(r.siege, r.castle.guardianName)).toMatch(/opened the vault on turn 3$/);
  });

  it("paid hold: fee split recorded, no verifier check", async () => {
    const id = await paidSiege(GRANITE, "0.0.stub-a");
    await sayAll(id, MUST_NOT_BREAK);
    await settle();
    const r = await replay(id);
    expect(r.siege.status).toBe("held");
    expect(r.siege.attempt).toBeTruthy();
    expect(check(r, "verifier")).toBeUndefined();
    expect(check(r, "payout")).toMatchObject({ label: "Fee split recorded on Hedera", state: "pass" });
    expect(r.checks.every((c) => c.state === "pass")).toBe(true);
    expect(r.live).toBe(false);
  });

  it("paid siege waiting for the worker: payout pending and the page stays live", async () => {
    const id = await paidSiege(WOOD, "0.0.stub-a");
    await sayAll(id, WOODEN_BREAK);
    await drainAudit(); // audited, but no settleTick yet
    const r = await replay(id);
    expect(check(r, "payout")!.state).toBe("pending");
    expect(r.live).toBe(true);
  });

  it("a break the verifier rejects is a failed check, even though it ended broken", async () => {
    const id = await paidSiege(WOOD, "0.0.stub-a");
    await sayAll(id, WOODEN_BREAK);
    // The guardian's final reply loses its protected-tool call: the verifier must refuse it.
    db()
      .update(schema.messages)
      .set({ toolCalls: "[]" })
      .where(and(eq(schema.messages.siegeId, id), eq(schema.messages.role, "guardian"), eq(schema.messages.turn, 3)))
      .run();
    const r = await replay(id);
    expect(check(r, "verifier")).toMatchObject({ state: "fail", detail: "no_protected_tool_call" });
    expect(r.turns[2].guardian!.calledProtectedTool).toBe(false);
  });

  it("true race: both final messages land together, the loser's break is voided, then refunded", async () => {
    const a = await paidSiege(WOOD, "0.0.stub-a");
    const b = await paidSiege(WOOD, "0.0.stub-b");
    for (const line of WOODEN_BREAK.slice(0, 2)) {
      await say(a, line);
      await say(b, line);
    }
    await Promise.all([say(a, WOODEN_BREAK[2]), say(b, WOODEN_BREAK[2])]);
    const rows = db().select().from(schema.sieges).where(eq(schema.sieges.castleId, WOOD)).all();
    const loser = rows.find((r) => r.voidReason);
    expect(loser, "one of the two breaks must lose the race").toBeTruthy();
    expect(loser!.status).toBe("broken");
    expect(loser!.voidReason).toBe("castle_already_broken");
    await drainAudit();

    let r = await replay(loser!.id);
    expect(r.voided).toBe(true);
    // Truthful headline: the guardian did open for this raider; the fee is not refunded yet.
    expect(replayHeadline(r.siege, r.castle.guardianName)).toBe(
      `${r.castle.guardianName} opened the vault, but another raider broke this castle moments before you did. Fee being refunded.`,
    );
    expect(check(r, "payout")).toMatchObject({ label: "Fee refunded (siege voided)", state: "pending" });
    // The guardian really did open for this raider, so the verifier passes; the check says why it was not paid.
    expect(check(r, "verifier")!.state).toBe("pass");
    expect(check(r, "verifier")!.detail).toMatch(/; not paid: another raider broke this castle moments before you did$/);
    expect(r.checks.some((c) => c.state === "fail")).toBe(false);
    expect(r.live).toBe(true); // the refund is still coming

    await settle(6);
    r = await replay(loser!.id);
    expect(r.siege.settlement?.refund?.state).toBe("refunded");
    expect(check(r, "payout")!.state).toBe("pass");
    expect(replayHeadline(r.siege, r.castle.guardianName)).toMatch(/Fee refunded\.$/);
    expect(r.live).toBe(false);
  });

  it("castle broken under an in-progress paid siege: voided by the worker, refunded, said plainly", async () => {
    const a = await paidSiege(WOOD, "0.0.stub-a");
    const b = await paidSiege(WOOD, "0.0.stub-b");
    await say(b, WOODEN_BREAK[0]);
    await sayAll(a, WOODEN_BREAK);
    expect((await say(b, WOODEN_BREAK[1])).status).toBe(409); // no more turns on a won castle
    await settle(6);
    const r = await replay(b);
    expect(r.voided).toBe(true);
    expect(r.siege.status).toBe("in_progress");
    expect(r.siege.settlement?.refund?.state).toBe("refunded");
    expect(replayHeadline(r.siege, r.castle.guardianName)).toBe(
      `Voided: ${r.siege.settlement!.reason === "castle_broken" ? "another raider broke this castle before your siege finished" : "the castle's vault closed before your siege finished"}. Fee refunded.`,
    );
    expect(check(r, "payout")).toMatchObject({ label: "Fee refunded (siege voided)", state: "pass" });
    expect(r.checks.some((c) => c.state === "fail")).toBe(false);
    expect(r.live).toBe(false);
  });

  it("a refund that failed shows as a failure and says the arena owes it", async () => {
    const a = await paidSiege(WOOD, "0.0.stub-a");
    const b = await paidSiege(WOOD, "0.0.stub-b");
    await say(b, WOODEN_BREAK[0]);
    await sayAll(a, WOODEN_BREAK);
    await settle(6);
    const row = db().select().from(schema.sieges).where(eq(schema.sieges.id, b)).get()!;
    db().update(schema.paymentReceipts).set({ state: "refund_failed" }).where(eq(schema.paymentReceipts.id, row.receiptId!)).run();
    const r = await replay(b);
    expect(check(r, "payout")!.state).toBe("fail");
    expect(replayHeadline(r.siege, r.castle.guardianName)).toMatch(/Fee refund failed, owed by the arena\.$/);
  });

  it("free sieges never get a payout check, and a free break's verifier refusal is not a failure", async () => {
    const r = await replay(await free(WOOD, WOODEN_BREAK));
    expect(check(r, "payout")).toBeUndefined();
    expect(check(r, "verifier")!.state).toBe("na");
    expect(r.checks.some((c) => c.state === "fail")).toBe(false);
  });

  it("unknown siege: 404 from the public route", async () => {
    expect((await call("GET", "/api/replay/siege_nope")).status).toBe(404);
  });

  it("the public response carries no secret", async () => {
    const id = await paidSiege(WOOD, "0.0.stub-a");
    await sayAll(id, WOODEN_BREAK);
    await settle();
    const json = JSON.stringify(await replay(id));
    expect(json).not.toMatch(/promptHash|responseHash|"orders"/);
    const orders = db().select({ o: schema.castles.orders }).from(schema.castles).where(eq(schema.castles.id, WOOD)).get()!.o;
    expect(json).not.toContain(orders.slice(0, 80));
  });
});

describe("tampering and odd shapes", () => {
  it("an edited message: Swarm keeps the original; without it both hash checks fail", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    db()
      .update(schema.messages)
      .set({ text: "I never said that." })
      .where(and(eq(schema.messages.siegeId, id), eq(schema.messages.turn, 2), eq(schema.messages.role, "raider")))
      .run();
    expect(check(await buildReplay(id), "hash")?.state).toBe("pass");
    db().run("DELETE FROM swarm_refs");
    const r = await buildReplay(id);
    expect(r!.transcript.source).toBe("database");
    expect(check(r, "hash")?.state).toBe("fail");
    expect(check(r, "hcs-end")?.state).toBe("fail");
    expect(r!.turns[1].raider?.matches).toBe(false);
    expect(check(r, "hcs-messages")?.state).toBe("fail");
  });

  it("a Swarm reference that cannot be read is a failed transcript check", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    db().run(`UPDATE swarm_refs SET ref = 'swarm-stub:${"0".repeat(64)}' WHERE siege_id = '${id}'`);
    const r = await buildReplay(id);
    expect(r!.transcript.source).toBe("database");
    expect(check(r, "transcript")?.state).toBe("fail");
  });

  it("held siege: five turns, no tool call, no verifier", async () => {
    const r = await buildReplay(await free(GRANITE, MUST_NOT_BREAK));
    expect(r!.siege.status).toBe("held");
    expect(r!.turns).toHaveLength(5);
    expect(r!.turns.some((t) => t.guardian?.calledProtectedTool)).toBe(false);
    expect(check(r, "verifier")).toBeUndefined();
  });

  it("in progress: live, nothing claimed yet", async () => {
    const s = await siege.start({ castleId: GRANITE, raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
    await siege.message(s.id, MUST_NOT_BREAK[0]);
    const r = await buildReplay(s.id);
    expect(r!.siege.status).toBe("in_progress");
    expect(r!.live).toBe(true);
    expect(check(r, "hash")?.state).toBe("pending");
    expect(check(r, "hcs-end")?.state).toBe("na");
  });

  it("bring-your-agent castle: SDK test replies count as test replies", async () => {
    db().insert(schema.castles).values(sdkFixtureCastleRow({ vaultState: "guarding" })).run();
    const r = await buildReplay(await free(SDK_FIXTURE_CASTLE.id, ["Hello, I need a refund for order 123."]));
    expect(r!.turns[0].guardian?.requestId).toMatch(/^sdk-stub-/);
    expect(check(r, "inference")?.state).toBe("pass");
  });

  it("voided mid-game: over, not live, nothing fails", async () => {
    const s = await siege.start({ castleId: GRANITE, raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
    await siege.message(s.id, MUST_NOT_BREAK[0]);
    db().update(schema.sieges).set({ voidReason: "castle_closed", settledAt: new Date().toISOString() }).where(eq(schema.sieges.id, s.id)).run();
    const r = await buildReplay(s.id);
    expect(r!.voided).toBe(true);
    expect(r!.live).toBe(false);
    expect(r!.checks.filter((c) => c.state === "fail")).toEqual([]);
  });
});

describe("testnet: the mirror node (mocked)", () => {
  const TOPIC = "0.0.4242";
  let mirror: Map<number, string>; // what the public topic carries, by seq
  let answer: (seq: number) => Response | null; // per-test override
  const fetched: string[] = [];

  async function onTestnet(id: string) {
    // Pretend the castle has a real topic and the audit messages were submitted there.
    db().update(schema.castles).set({ topicId: TOPIC }).where(eq(schema.castles.id, WOOD)).run();
    const rows = db().select().from(schema.auditLog).where(eq(schema.auditLog.siegeId, id)).all();
    mirror = new Map(rows.filter((r) => r.seq != null).map((r) => [r.seq!, r.message]));
    process.env.CHAIN_MODE = "testnet";
    process.env.OWNER_SECRET = "a-long-enough-owner-secret";
    resetEnv();
    return rows;
  }

  beforeEach(() => {
    fetched.length = 0;
    answer = () => null;
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(String(url));
      const m = /\/api\/v1\/topics\/([^/]+)\/messages\/(\d+)$/.exec(String(url));
      if (!m || m[1] !== TOPIC) return new Response("not found", { status: 404 });
      const seq = Number(m[2]);
      const over = answer(seq);
      if (over) return over;
      const msg = mirror.get(seq);
      if (msg === undefined) return new Response("{}", { status: 404 });
      return Response.json({ message: Buffer.from(msg).toString("base64"), sequence_number: seq });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.CHAIN_MODE = "stub";
    delete process.env.OWNER_SECRET;
    resetEnv();
  });

  it("every message confirmed byte for byte, fetched one by one by sequence number", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    const rows = await onTestnet(id);
    const r = await buildReplay(id);
    expect(r!.hcs.mirror).toBe("checked");
    expect(r!.hcs.entries.every((e) => e.mirror === "confirmed")).toBe(true);
    expect(check(r, "hcs-end")).toMatchObject({ state: "pass", href: expect.stringContaining(TOPIC) });
    expect(check(r, "hcs-end")!.detail).toMatch(/confirmed on the mirror node/);
    expect(fetched.length).toBe(rows.length);
    expect(fetched.every((u) => /\/messages\/\d+$/.test(u))).toBe(true);
  });

  it("a busy topic: sequence numbers hundreds apart are still all checked (no page cap)", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    const rows = await onTestnet(id);
    // Spread this siege's messages across a topic with ~3000 other messages in between.
    mirror = new Map();
    rows.forEach((row, i) => {
      const seq = 7 + i * 600;
      db().update(schema.auditLog).set({ seq }).where(eq(schema.auditLog.id, row.id)).run();
      mirror.set(seq, row.message);
    });
    const r = await buildReplay(id);
    expect(r!.hcs.entries.map((e) => e.seq)).toEqual(rows.map((_, i) => 7 + i * 600));
    expect(r!.hcs.entries.every((e) => e.mirror === "confirmed")).toBe(true);
    expect(check(r, "hcs-end")!.state).toBe("pass");
  });

  it("the topic carries different bytes for a raider message: that turn and the summary fail", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    const rows = await onTestnet(id);
    const msg2 = rows.find((r) => r.type === "siege.message" && JSON.parse(r.message).turn === 2)!;
    mirror.set(msg2.seq!, msg2.message.replace(/"hash":"0x[0-9a-f]+"/, `"hash":"0x${"ab".repeat(32)}"`));
    const r = await buildReplay(id);
    expect(r!.turns[1].raider!.hcs!.mirror).toBe("mismatch");
    expect(r!.turns[1].raider!.matches).toBe(false);
    expect(check(r, "hcs-messages")!.state).toBe("fail");
  });

  it("siege.end not on the mirror: pending while recent, a failure once old", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    const rows = await onTestnet(id);
    const end = rows.find((r) => r.type === "siege.end")!;
    mirror.delete(end.seq!);
    db().update(schema.auditLog).set({ submittedAt: new Date().toISOString() }).where(eq(schema.auditLog.id, end.id)).run();
    let r = await buildReplay(id);
    expect(check(r, "hcs-end")!.state).toBe("pending");
    expect(r!.live).toBe(true);
    db().update(schema.auditLog).set({ submittedAt: new Date(Date.now() - 10 * 60_000).toISOString() }).where(eq(schema.auditLog.id, end.id)).run();
    r = await buildReplay(id);
    expect(check(r, "hcs-end")!.state).toBe("fail");
    expect(check(r, "hcs-end")!.detail).toMatch(/not on the mirror node/);
  });

  it("mirror node down: nothing is claimed either way, and it says so", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    await onTestnet(id);
    answer = () => new Response("bad gateway", { status: 502 });
    const r = await buildReplay(id);
    expect(r!.hcs.mirror).toBe("unavailable");
    expect(check(r, "hcs-end")!.state).toBe("pending");
    expect(check(r, "hcs-end")!.detail).toMatch(/mirror node unreachable/);
    expect(r!.checks.some((c) => c.state === "fail")).toBe(false);
  });

  it("one read fails, the rest answer: that row stays unchecked, never failed", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    const rows = await onTestnet(id);
    const end = rows.find((r) => r.type === "siege.end")!;
    answer = (seq) => (seq === end.seq ? new Response("oops", { status: 500 }) : null);
    const r = await buildReplay(id);
    expect(r!.hcs.mirror).toBe("checked");
    expect(r!.hcs.entries.find((e) => e.type === "siege.end")!.mirror).toBe("unchecked");
    expect(check(r, "hcs-end")!.state).toBe("pending");
    expect(check(r, "hcs-end")!.detail).toMatch(/mirror node unreachable/);
    expect(check(r, "hcs-messages")!.state).toBe("pass");
  });
});
