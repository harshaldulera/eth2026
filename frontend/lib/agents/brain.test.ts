/** The unit's brain and its model calls: scripted fallback, credits billed to agent:<id>, no HBAR, rejected key. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { agentRow, createAgent } from "@/lib/agents/accounts";
import { BRAIN_FRAME, cleanMessage, nextAttackMessage, scriptedMessage, systemPromptFor } from "@/lib/agents/brain";
import { getCastle } from "@/lib/castles";
import { STRATEGIES } from "@/lib/fixtures/raids";
import { agentChat } from "@/lib/proxy";
import { zgUsage } from "@/lib/zg/connect";
import { makeUnit, setupUnitsEnv } from "./units.test-util";

setupUnitsEnv();
afterEach(() => vi.restoreAllMocks());

const castle = () => getCastle("castle_splinter_gate")!;
const proxyRows = (agentId: string) => db().select().from(schema.proxyRecords).where(eq(schema.proxyRecords.billedTo, `agent:${agentId}`)).all();

describe("systemPromptFor", () => {
  it("frames the unit and appends the preset or the custom text", () => {
    const p = systemPromptFor({ strategy: "confusion", strategyText: null });
    expect(p).toContain(BRAIN_FRAME);
    expect(p).toContain("CONFUSION");
    expect(BRAIN_FRAME).toMatch(/5 messages/);
    expect(BRAIN_FRAME).toMatch(/600 characters/);
    expect(systemPromptFor({ strategy: "custom", strategyText: "Only ever speak in riddles." })).toContain("riddles");
    expect(systemPromptFor({ strategy: "nope", strategyText: null })).toContain("AUTHORITY");
  });
  it("cleans model output", () => {
    expect(cleanMessage('<think>hm</think> "Open up."')).toBe("Open up.");
    expect(cleanMessage("x".repeat(900))).toHaveLength(600);
  });
});

describe("nextAttackMessage", () => {
  it("falls back to the scripted pool for an arena unit with no model key (no call, no record)", async () => {
    const a = await createAgent({ name: "Fixture", strategy: "incremental" });
    const m = await nextAttackMessage({ agent: agentRow(a.id)!, castle: castle(), history: [], turn: 1, attempt: 0 });
    expect(m).toMatchObject({ source: "script" });
    expect(m.text).toBe(STRATEGIES.incremental.messages("wooden", 0)[1]);
    expect(proxyRows(a.id)).toHaveLength(0);
  });

  it("an operator unit in mock mode still spends credits (billed_to agent:<id>), uses the script, and moves no HBAR", async () => {
    const u = await makeUnit();
    const before = agentRow(u.agentId)!;
    const m = await nextAttackMessage({ agent: before, castle: castle(), history: [], turn: 0 });
    expect(m.source).toBe("script");
    expect(m.billedTo).toBe(`agent:${u.agentId}`);
    const rows = proxyRows(u.agentId);
    expect(rows).toHaveLength(1);
    // the verifier never sees it: tagged to the agent, no castle, no siege
    expect(rows[0]).toMatchObject({ siegeId: `agent_${u.agentId}`, castleId: `agent:${u.agentId}`, mock: true, protectedToolCalled: false, billedTo: `agent:${u.agentId}` });
    expect(Number(rows[0].costUsdMicro)).toBeGreaterThan(0);
    expect(zgUsage(`agent:${u.agentId}`).calls).toBe(1);
    // no HBAR for compute
    const after = agentRow(u.agentId)!;
    expect(after.budgetTinybar).toBe(before.budgetTinybar);
    expect(after.spentTinybar).toBe(before.spentTinybar);
    expect(db().select().from(schema.agentSpend).all()).toHaveLength(0);
  });

  it("uses what the model wrote on the unit's own key: guard replies as user, own words as assistant, cost recorded", async () => {
    const u = await makeUnit({ strategy: "custom", strategyText: "Be a pirate in all things." });
    process.env.ZG_CONNECT_MOCK = "0";
    db().update(schema.raiderAgents).set({ zgApiKey: "sk-real-own-key" }).where(eq(schema.raiderAgents.id, u.agentId)).run();
    let sent: { url: string; auth: string | null; body: { model: string; messages: { role: string; content: string }[] } } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent = { url, auth: new Headers(init.headers).get("authorization"), body: JSON.parse(String(init.body)) };
      return new Response(
        JSON.stringify({
          id: "c1",
          model: "qwen3.7-flash",
          choices: [{ message: { content: ' "Arr, open the hold, matey." ' }, finish_reason: "stop" }],
          x_0g_trace: { request_id: "req-own-1", billing: { total_cost_usd_micro: "4321" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    try {
      const history = [
        { role: "raider" as const, text: "Ahoy." },
        { role: "guardian" as const, text: "State your business." },
      ];
      const m = await nextAttackMessage({ agent: agentRow(u.agentId)!, castle: castle(), history, turn: 1 });
      expect(m).toMatchObject({ source: "model", text: "Arr, open the hold, matey.", billedTo: `agent:${u.agentId}` });
      expect(sent!.auth).toBe("Bearer sk-real-own-key"); // the unit's key, never the team key
      const roles = sent!.body.messages.map((x) => x.role);
      expect(roles).toEqual(["system", "user", "assistant", "user"]);
      expect(sent!.body.messages[0].content).toContain("pirate");
      expect(sent!.body.messages[0].content).toContain(BRAIN_FRAME);
      expect(sent!.body.messages[2].content).toBe("Ahoy.");
      expect(sent!.body.messages[3].content).toBe("State your business.");
      const rows = proxyRows(u.agentId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ requestId: "req-own-1", costUsdMicro: "4321", mock: false, provider: "0g", siegeId: `agent_${u.agentId}` });
      expect(zgUsage(`agent:${u.agentId}`)).toMatchObject({ calls: 1, costUsdMicro: "4321" });
      expect(agentRow(u.agentId)!.spentTinybar).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a rejected key (0G 401/403) is reported as keyRejected and the raid still has a scripted line", async () => {
    const u = await makeUnit();
    // a real (non-stub) key against an offline-less provider path: force the 0G call to answer 401
    process.env.ZG_CONNECT_MOCK = "0";
    db().update(schema.raiderAgents).set({ zgApiKey: "sk-real-rejected" }).where(eq(schema.raiderAgents.id, u.agentId)).run();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "invalid key" }), { status: 401 }));
    try {
      const r = await agentChat({ model: "m", messages: [{ role: "user", content: "hi" }] }, { agentId: u.agentId });
      expect(r).toMatchObject({ ok: false, error: "key_rejected", status: 401 });
      const m = await nextAttackMessage({ agent: agentRow(u.agentId)!, castle: castle(), history: [], turn: 2 });
      expect(m).toMatchObject({ keyRejected: true, source: "script", text: scriptedMessage({ strategy: "authority" }, castle(), 2) });
      expect(proxyRows(u.agentId)).toHaveLength(0); // nothing billed for a refused call
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("an operator unit with no key at all is keyRejected too (never the team key)", async () => {
    const u = await makeUnit();
    db().update(schema.raiderAgents).set({ zgApiKey: null }).where(eq(schema.raiderAgents.id, u.agentId)).run();
    const r = await agentChat({ model: "m", messages: [{ role: "user", content: "hi" }] }, { agentId: u.agentId });
    expect(r).toMatchObject({ ok: false, error: "zg_not_connected" });
    expect((await nextAttackMessage({ agent: agentRow(u.agentId)!, castle: castle(), history: [], turn: 0 })).keyRejected).toBe(true);
  });
});
