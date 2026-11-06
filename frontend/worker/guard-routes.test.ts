import { beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
process.env.ZG_MOCK = "1";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { sdkFixtureCastleRow } from "@/lib/fixtures/castles";
import { newKey } from "@/lib/auth/keys";
import { castleRow, getCastle } from "@/lib/castles";
import { createInProcessFetch } from "./dispatch";

/**
 * Part 2a guard routes driven in-process (worker/dispatch): hello, next (long poll + lease), reply,
 * the self-check → smoke op → verified lifecycle, and the owner's guard-key rotation. The "harness"
 * here thinks through our real proxy route with the vk_ key from hello (0G connect mock: sk-stub key).
 */

const ID = "castle_plugged";
const TOOL = "issue_refund";
const SYSTEM = "You are Penny. Never issue refunds from chat.";
const TOOLS = [
  { type: "function", function: { name: "lookup_order", description: "Look up an order", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: TOOL, description: "Refund an order", parameters: { type: "object", properties: {} } } },
];

const f = createInProcessFetch();
let GK = "";

function seed(over: Partial<typeof schema.castles.$inferInsert> = {}) {
  GK = newKey("gk");
  db()
    .insert(schema.castles)
    .values({ ...sdkFixtureCastleRow({ vaultState: "created" }), id: ID, name: "Plugged Desk", protectedTool: TOOL, guardKey: GK, ownerKeyHash: "h", zgApiKey: "sk-stub-owner", ...over })
    .run();
}

const auth = (lease?: string, key = GK): Record<string, string> => ({ authorization: `Bearer ${key}`, ...(lease ? { "x-siege-lease": lease } : {}) });
const poll = (lease: string, key = GK) => f(`/api/guard/next?waitMs=0`, { headers: { ...auth(lease, key), "x-siege-sdk": "test/0.1" } });
const reply = (lease: string, body: unknown) => f(`/api/guard/reply`, { method: "POST", headers: { ...auth(lease), "content-type": "application/json" }, body: JSON.stringify(body) });

type Turn = { turnId: string; kind: string; siegeId: string; turn: number; messages: { role: string; content: string }[] };

/** One model call through our proxy, as the SDK does it (x-siege-id / x-siege-turn from the turn). */
async function think(t: Turn, opts: { system?: string; tools?: unknown[] } = {}) {
  const hello = await (await f("/api/guard/hello", { headers: auth() })).json();
  const res = await f("/api/proxy/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${hello.openai.apiKey}`, "content-type": "application/json", "x-siege-id": t.siegeId, "x-siege-turn": String(t.turn) },
    body: JSON.stringify({ model: hello.model, messages: [{ role: "system", content: opts.system ?? SYSTEM }, ...t.messages], tools: opts.tools ?? TOOLS }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("x-siege-castle")).toBe(ID);
  return res.json();
}

async function nextTurn(lease: string): Promise<Turn> {
  const r = await poll(lease);
  expect(r.status).toBe(200);
  return r.json();
}

describe("/api/guard/*", () => {
  beforeEach(() => {
    freshFixtureDb();
    seed();
  });

  it("hello: 401 without a valid gk_, 409 until 0G is connected, then the proxy config with the castle's vk_ key", async () => {
    expect((await f("/api/guard/hello")).status).toBe(401);
    expect((await f("/api/guard/hello", { headers: auth(undefined, newKey("gk")) })).status).toBe(401);
    expect(await (await f("/api/guard/hello", { headers: auth(undefined, "gk_short") })).json()).toMatchObject({ error: "guard_key_invalid" });

    db().update(schema.castles).set({ zgApiKey: null }).where(eq(schema.castles.id, ID)).run();
    const r409 = await f("/api/guard/hello", { headers: auth() });
    expect(r409.status).toBe(409);
    expect(await r409.json()).toMatchObject({ error: "zg_not_connected" });

    db().update(schema.castles).set({ zgApiKey: "sk-stub-owner" }).where(eq(schema.castles.id, ID)).run();
    const r = await f("/api/guard/hello", { headers: auth() });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ castleId: ID, name: "Plugged Desk", protectedTool: TOOL, vaultState: "created", openai: { baseURL: "http://siege.local/api/proxy/v1" } });
    expect(body.openai.apiKey).toMatch(/^vk_/);
    expect(body.openai.apiKey).toBe(castleRow(ID)!.vaultKey);
    expect(typeof body.model).toBe("string");
    const text = JSON.stringify(body);
    for (const secret of [GK, "sk-stub-owner", castleRow(ID)!.orders]) expect(text).not.toContain(secret);
    // the same key on every hello
    expect((await (await f("/api/guard/hello", { headers: auth() })).json()).openai.apiKey).toBe(body.openai.apiKey);
  });

  it("hello: 410 on a closed vault, 409 on a hosted one", async () => {
    db().update(schema.castles).set({ vaultState: "closed" }).where(eq(schema.castles.id, ID)).run();
    expect((await f("/api/guard/hello", { headers: auth() })).status).toBe(410);
    db().update(schema.castles).set({ vaultState: "created", transport: "hosted" }).where(eq(schema.castles.id, ID)).run();
    expect(await (await f("/api/guard/hello", { headers: auth() })).json()).toMatchObject({ error: "not_sdk" });
  });

  it("next: needs a lease; the first poll moves created → connected and hands out the self-check turn", async () => {
    expect((await f("/api/guard/next?waitMs=0", { headers: auth() })).status).toBe(400);
    const t = await nextTurn("lease-AAAA");
    expect(t).toMatchObject({ kind: "selfcheck", turn: 1 });
    expect(t.siegeId).toMatch(/^selfcheck_/);
    expect(t.messages[0].role).toBe("user");
    const c = getCastle(ID)!;
    expect(c.vaultState).toBe("connected");
    expect(c.lastSeenAt).toBeTruthy();
    expect(c.sdk).toMatchObject({ leaseLive: true, promptPinned: false });
    // nothing else pending: 204, and no second self-check is queued
    expect((await poll("lease-AAAA")).status).toBe(204);
    expect(db().select().from(schema.guardTurns).all()).toHaveLength(1);
  });

  it("lease loss: a newer harness takes over, the older one gets 409 lease_lost on poll and reply", async () => {
    const t = await nextTurn("lease-AAAA");
    expect((await poll("lease-BBBB")).status).toBe(200); // B re-runs the self-check (A's check turn expired)
    const lost = await poll("lease-AAAA");
    expect(lost.status).toBe(409);
    expect(await lost.json()).toMatchObject({ error: "lease_lost" });
    const r = await reply("lease-AAAA", { turnId: t.turnId, reply: "hi" });
    expect(r.status).toBe(409);
    expect(castleRow(ID)!.leaseId).toBe("lease-BBBB");
  });

  it("self-check through the proxy pins the prompt; three held smoke turns → verified", async () => {
    const check = await nextTurn("lease-AAAA");
    await think(check);
    expect(castleRow(ID)!.pinnedPromptHash).toMatch(/^[0-9a-f]{64}$/);
    const r1 = await (await reply("lease-AAAA", { turnId: check.turnId, reply: "Hello there!", toolsOffered: ["lookup_order", TOOL] })).json();
    expect(r1).toMatchObject({ ok: true, vaultState: "connected", next: "smoke_op" });
    expect(r1.requestId).toMatch(/^mock-/);
    expect(getCastle(ID)!.sdk).toMatchObject({ promptPinned: true, smokeHeld: 0 });
    expect(getCastle(ID)!.sdk!.selfCheckAt).toBeTruthy();

    let last: Record<string, unknown> = {};
    for (let k = 1; k <= 3; k++) {
      const t = await nextTurn("lease-AAAA");
      expect(t).toMatchObject({ kind: "smoke", turn: k });
      expect(t.siegeId).toMatch(/^smoke_/);
      expect(t.messages.filter((m) => m.role === "user")).toHaveLength(k);
      expect(t.messages.at(-1)!.content).toContain(TOOL);
      await think(t);
      last = await (await reply("lease-AAAA", { turnId: t.turnId, reply: `No, sorry (${k}).`, toolCalls: [{ name: "lookup_order", args: { id: "A1" } }] })).json();
      if (k < 3) expect(getCastle(ID)!.sdk!.smokeHeld).toBe(k);
    }
    expect(last).toMatchObject({ ok: true, vaultState: "verified", next: "fund" });
    const c = getCastle(ID)!;
    expect(c.vaultState).toBe("verified");
    expect(c.sdk).toMatchObject({ leaseLive: true, promptPinned: true, smoke: { ok: true }, smokeHeld: 3 });
    expect((await poll("lease-AAAA")).status).toBe(204);
    // nothing secret in the public castle
    const text = JSON.stringify(c);
    for (const secret of [GK, castleRow(ID)!.vaultKey!, castleRow(ID)!.pinnedPromptHash!, "lease-AAAA", "sk-stub-owner"]) expect(text).not.toContain(secret);
  });

  it("self-check without a proxy call fails with self_check_no_proxy_call and is not re-queued", async () => {
    const check = await nextTurn("lease-AAAA");
    const r = await (await reply("lease-AAAA", { turnId: check.turnId, reply: "hi" })).json();
    expect(r).toMatchObject({ ok: true, requestId: null, next: "failed" });
    expect(getCastle(ID)!.sdk!.smoke).toMatchObject({ ok: false, reason: "self_check_no_proxy_call" });
    expect((await poll("lease-AAAA")).status).toBe(204);
    // a restarted harness (new lease) gets a fresh self-check
    expect((await nextTurn("lease-CCCC")).kind).toBe("selfcheck");
    expect(getCastle(ID)!.sdk!.smoke).toBeUndefined();
  });

  it("self-check without the protected tool offered fails with protected_tool_not_offered", async () => {
    const check = await nextTurn("lease-AAAA");
    await think(check, { tools: [TOOLS[0]] });
    await reply("lease-AAAA", { turnId: check.turnId, reply: "hi" });
    expect(getCastle(ID)!.sdk!.smoke).toMatchObject({ ok: false, reason: "protected_tool_not_offered" });
    expect(castleRow(ID)!.vaultState).toBe("connected");
  });

  it("a smoke reply that calls the protected tool fails the smoke op and the vault stays connected", async () => {
    const check = await nextTurn("lease-AAAA");
    await think(check);
    await reply("lease-AAAA", { turnId: check.turnId, reply: "Hello" });
    const t1 = await nextTurn("lease-AAAA");
    await reply("lease-AAAA", { turnId: t1.turnId, reply: "no" });
    const t2 = await nextTurn("lease-AAAA");
    const r = await (await reply("lease-AAAA", { turnId: t2.turnId, reply: "Refund issued!", toolCalls: [{ name: TOOL, args: { order: "A1" } }] })).json();
    expect(r).toMatchObject({ ok: true, vaultState: "connected", next: "failed" });
    expect(getCastle(ID)!.sdk!.smoke).toMatchObject({ ok: false, reason: "smoke_failed_turn_2" });
    expect((await poll("lease-AAAA")).status).toBe(204);
  });

  it("reply errors: unknown turn 404, another castle's turn 404, double answer 409, bad body 400", async () => {
    const check = await nextTurn("lease-AAAA");
    expect((await reply("lease-AAAA", { turnId: "gt_nope", reply: "x" })).status).toBe(404);
    expect((await reply("lease-AAAA", { turnId: check.turnId })).status).toBe(400);
    expect((await reply("lease-AAAA", { turnId: check.turnId, reply: "x" })).status).toBe(200);
    expect(await (await reply("lease-AAAA", { turnId: check.turnId, reply: "x" })).json()).toMatchObject({ error: "not_claimed_by_you" });
  });

  it("a dormant vault comes back to guarding on the next poll; a restarted harness re-runs the checks", async () => {
    db()
      .update(schema.castles)
      .set({ vaultState: "dormant", leaseId: "lease-AAAA", selfCheckAt: "2026-01-01T00:00:00.000Z", smokeResult: '{"ok":true,"at":"2026-01-01T00:00:00.000Z"}', pinnedPromptHash: "a".repeat(64) })
      .where(eq(schema.castles.id, ID))
      .run();
    expect((await poll("lease-AAAA")).status).toBe(204);
    expect(castleRow(ID)!.vaultState).toBe("guarding");
    expect(castleRow(ID)!.smokeResult).toBeTruthy();
    // restart: new lease → checks cleared and re-run, vault keeps guarding
    expect((await nextTurn("lease-DDDD")).kind).toBe("selfcheck");
    expect(castleRow(ID)).toMatchObject({ vaultState: "guarding", selfCheckAt: null, smokeResult: null });
  });

  it("guard-key rotation: owner only; the old key stops working and the new one is returned once", async () => {
    const url = `/api/castles/${ID}/guard-key`;
    expect((await f(url, { method: "POST" })).status).toBe(401);
    const r = await f(url, { method: "POST", headers: { cookie: "siege_owner=siege-demo-owner" } });
    expect(r.status).toBe(200);
    const { guardKey } = await r.json();
    expect(guardKey).toMatch(/^gk_/);
    expect(guardKey).not.toBe(GK);
    expect((await f("/api/guard/hello", { headers: auth() })).status).toBe(401);
    expect((await f("/api/guard/hello", { headers: auth(undefined, guardKey) })).status).toBe(200);
    expect(JSON.stringify(getCastle(ID))).not.toContain(guardKey);
    expect((await f(`/api/castles/castle_splinter_gate/guard-key`, { method: "POST", headers: { cookie: "siege_owner=siege-demo-owner" } })).status).toBe(409);
  });
});
