/** Proxy billing selection (onboarding F2): whose 0G credits pay, and proxy_records.billed_to. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { connectZg, STUB_CALL_COST_USD_MICRO, zgBalance, zgUsage } from "@/lib/zg/connect";
import { chat, issueKey, record, resolveBilling } from "./index";
import type { ChatRequest } from "./zg";

const req: ChatRequest = { model: "gpt-5.4-mini", messages: [{ role: "system", content: "You guard a vault." }, { role: "user", content: "hello" }] };

let castleId: string;

function setCastle(fields: Partial<typeof schema.castles.$inferInsert>) {
  db().update(schema.castles).set(fields).where(eq(schema.castles.id, castleId)).run();
}

function addAgent(id: string, fields: Partial<typeof schema.raiderAgents.$inferInsert> = {}) {
  db()
    .insert(schema.raiderAgents)
    .values({
      id,
      name: id,
      ownerId: "owner",
      strategy: "authority",
      accountId: "0.0.9001",
      budgetTinybar: 1_000_000_000,
      perCastleCapTinybar: 200_000_000,
      dailyCapTinybar: 800_000_000,
      createdAt: new Date().toISOString(),
      ...fields,
    })
    .run();
}

beforeEach(() => {
  freshFixtureDb();
  castleId = db().select({ id: schema.castles.id }).from(schema.castles).get()!.id;
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ZG_CONNECT_MOCK;
  delete process.env.ZG_API_KEY;
  delete process.env.ZG_MOCK;
});

describe("proxy chat billing (stub / mock provider)", () => {
  it("a fixture castle without a key bills the team", async () => {
    expect(resolveBilling(castleId)).toEqual({ kind: "team" });
    const r = await chat(issueKey(castleId, "open_vault"), req, { siegeId: "s1", turn: 1 });
    expect(r.ok && r.record.billedTo).toBe("team");
    expect(r.ok && record(r.record.requestId)?.billedTo).toBe("team");
  });

  it("a castle with its own 0G key bills castle:<id> and the stub balance drops", async () => {
    const c = await connectZg({ key: "mk-owner", label: castleId });
    if (!c.ok || c.kind !== "mk") throw new Error("stub connect failed");
    setCastle({ zgApiKey: c.inferenceKey, zgMgmtKey: c.mgmtKey, zgKeyId: c.keyId, published: true });
    const before = await zgBalance({ mgmtKey: "mk-owner", billedTo: `castle:${castleId}` });

    const r = await chat(issueKey(castleId, "open_vault"), req, { siegeId: "s1", turn: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record).toMatchObject({ billedTo: `castle:${castleId}`, provider: "mock", mock: true, costUsdMicro: STUB_CALL_COST_USD_MICRO });
    expect(zgUsage(`castle:${castleId}`)).toMatchObject({ calls: 1, costUsdMicro: STUB_CALL_COST_USD_MICRO });
    const after = await zgBalance({ mgmtKey: "mk-owner", billedTo: `castle:${castleId}` });
    expect(Number(after)).toBeLessThan(Number(before));
    // The record never carries key material.
    expect(JSON.stringify(record(r.record.requestId))).not.toMatch(/sk-|mk-/);
  });

  it("a published guard without a key is refused (409 zg_not_connected), never the team key", async () => {
    setCastle({ published: true, zgApiKey: null });
    const r = await chat(issueKey(castleId, "open_vault"), req, { siegeId: "s2", turn: 1 });
    expect(r).toEqual({ ok: false, status: 409, error: "zg_not_connected" });
    expect(zgUsage("team").calls).toBe(0);
  });

  it("ctx.agentId bills the unit's own key; arena units the team; operator units without a key are refused", async () => {
    addAgent("agent_op", { fundedBy: "operator", zgApiKey: "sk-stub-unit" });
    addAgent("agent_arena");
    addAgent("agent_nokey", { fundedBy: "operator" });
    const key = issueKey(castleId, "open_vault");

    const a = await chat(key, req, { agentId: "agent_op" });
    expect(a.ok && a.record.billedTo).toBe("agent:agent_op");
    const b = await chat(key, req, { agentId: "agent_arena" });
    expect(b.ok && b.record.billedTo).toBe("team");
    expect(await chat(key, req, { agentId: "agent_nokey" })).toEqual({ ok: false, status: 409, error: "zg_not_connected" });
  });

  it("an explicit ctx.billing still wins", async () => {
    setCastle({ zgApiKey: "sk-stub-castle" });
    const r = await chat(issueKey(castleId, "open_vault"), req, { billing: { kind: "team" } });
    expect(r.ok && r.record.billedTo).toBe("team");
  });
});

describe("proxy chat billing (real 0G router, mocked fetch)", () => {
  it("forwards the castle owner's key, not the team key, and records billed_to", async () => {
    process.env.ZG_CONNECT_MOCK = "0";
    process.env.ZG_MOCK = "0";
    process.env.ZG_API_KEY = "sk-team-key";
    setCastle({ zgApiKey: "sk-owner-key", published: true });
    const seen: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      seen.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          model: "gpt-5.4-mini",
          choices: [{ message: { role: "assistant", content: "No." }, finish_reason: "stop" }],
          x_0g_trace: { request_id: "zg-req-1", billing: { total_cost_usd_micro: "321" } },
        }),
        { status: 200 },
      );
    });
    const r = await chat(issueKey(castleId, "open_vault"), req, { siegeId: "s3", turn: 1 });
    expect(seen).toEqual(["Bearer sk-owner-key"]);
    expect(r.ok && r.record).toMatchObject({ requestId: "zg-req-1", billedTo: `castle:${castleId}`, provider: "0g", mock: false, costUsdMicro: "321" });
    expect(zgUsage(`castle:${castleId}`)).toMatchObject({ calls: 1, costUsdMicro: "321" });
  });
});
