/**
 * J3 + J4 through the real routes and the worker, in stub mode: rk auth matrix (own unit ok, another
 * operator's 401, owner ok), POST /api/agents (draft path vs owner path), play/start paid from a unit,
 * withdraw preconditions, a worker run whose model calls bill agent:<id>, and a rejected key pausing the unit.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
process.env.SIEGE_FAST = "1";
import { eq } from "drizzle-orm";
import { env } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { agentRow, createAgent } from "@/lib/agents/accounts";
import { HBAR, makeUnit, setupUnitsEnv } from "@/lib/agents/units.test-util";
import { requestApproval } from "@/lib/pay";
import { createInProcessFetch } from "./dispatch";
import { setFetch } from "./fetch";
import { agentsTick } from "./agents";
import { setWorkerQuiet } from "./log";
import { startRun } from "@/app/api/_lib/runs";

setWorkerQuiet(true);
const BASE = "http://localhost:3000";
const f = createInProcessFetch(BASE);
const WOOD = "castle_splinter_gate";
/** A stone vault: the scripted lines never break it, so a run keeps going until a cap. Fee 1 ℏ. */
const STONE = "castle_granite_hold";

setupUnitsEnv();
setFetch(f);
afterAll(() => setFetch(null));
afterEach(() => vi.unstubAllGlobals());

async function call<T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await f(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as T, headers: res.headers };
}
const rk = (k: string) => ({ "x-siege-operator-key": k });
async function ownerCookie(): Promise<Record<string, string>> {
  const res = await f(`${BASE}/api/owner`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: env().OWNER_SECRET }) });
  return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
}

describe("POST /api/agents", () => {
  it("without the owner cookie: 201 {draft, deposit, operatorKey}; the unit is open (stub) and listed under its key only", async () => {
    const r = await call<{ draft: { id: string; state: string; agentId?: string }; deposit: { memo: string; to: string }; operatorKey: string }>("POST", "/api/agents", { name: "Vex", zgKey: "mk-abc", budget: String(5 * HBAR) });
    expect(r.status).toBe(201);
    expect(r.data.operatorKey).toMatch(/^rk_/);
    expect(r.data.deposit.memo).toMatch(/^siege:/);
    expect(r.data.draft.state).toBe("created");
    const draft = await call<{ draft: { state: string }; agent?: { id: string; fundedBy: string } }>("GET", `/api/agents/drafts/${r.data.draft.id}`);
    expect(draft.status).toBe(200);
    expect(draft.data.agent).toMatchObject({ fundedBy: "operator" });
    expect((await call("GET", "/api/agents/drafts/nope")).status).toBe(404);
    // no secrets anywhere in what the routes returned
    expect(JSON.stringify([r.data.draft, draft.data])).not.toMatch(/rk_|mk-abc|sk-stub|operatorKeyHash/);

    const mine = await call<{ agents: { id: string }[] }>("GET", "/api/agents?mine=1", undefined, rk(r.data.operatorKey));
    expect(mine.data.agents.map((a) => a.id)).toEqual([draft.data.agent!.id]);
    expect((await call<{ agents: unknown[] }>("GET", "/api/agents?mine=1")).data.agents).toEqual([]);
    expect((await call<{ agents: unknown[] }>("GET", "/api/agents?mine=1", undefined, rk("rk_" + "a".repeat(24)))).data.agents).toEqual([]);
  });

  it("validation: no 0G key 400, bad key 400 zg_failed, over limit 400, budget floor 400, custom needs text", async () => {
    expect((await call("POST", "/api/agents", { name: "x" })).status).toBe(400);
    expect(await call("POST", "/api/agents", { zgKey: "garbage" }).then((r) => [r.status, r.data])).toEqual([400, { error: "zg_failed", reason: "unauthorized" }]);
    expect((await call("POST", "/api/agents", { zgKey: "mk-a", budget: String(99 * HBAR) })).data).toMatchObject({ error: "over_limit" });
    expect((await call("POST", "/api/agents", { zgKey: "mk-a", budget: "1000" })).data).toMatchObject({ error: "budget_too_small" });
    expect((await call("POST", "/api/agents", { zgKey: "mk-a", strategy: "custom" })).status).toBe(400);
    expect(db().select().from(schema.unitDrafts).all()).toHaveLength(0);
  });

  it("the owner-cookie path is unchanged: {agent}, funded by the arena, no deposit", async () => {
    const r = await call<{ agent: { fundedBy: string; owner: string } }>("POST", "/api/agents", { name: "Night Sapper" }, await ownerCookie());
    expect(r.status).toBe(200);
    expect(r.data.agent).toMatchObject({ fundedBy: "arena", owner: "owner" });
    expect(db().select().from(schema.depositIntents).all()).toHaveLength(0);
  });
});

describe("operator key auth matrix", () => {
  it("run / stop / withdraw / detail: own key ok, another operator's key 401, no key 401, owner ok", async () => {
    const a = await makeUnit({ name: "A" });
    const b = await makeUnit({ name: "B" });
    const owner = await ownerCookie();
    for (const [path, body] of [
      [`/api/agents/${b.agentId}/run`, { castleId: WOOD }],
      [`/api/agents/${b.agentId}/stop`, {}],
      [`/api/agents/${b.agentId}/withdraw`, {}],
    ] as const) {
      expect((await call("POST", path, body, rk(a.operatorKey))).status, `A on B ${path}`).toBe(401);
      expect((await call("POST", path, body)).status, `none ${path}`).toBe(401);
    }
    // own unit
    expect((await call("POST", `/api/agents/${a.agentId}/run`, { castleId: WOOD }, rk(a.operatorKey))).status).toBe(200);
    expect(agentRow(a.agentId)!.status).toBe("running");
    expect((await call("POST", `/api/agents/${a.agentId}/stop`, {}, rk(a.operatorKey))).status).toBe(200);
    expect(agentRow(a.agentId)!.status).toBe("stopped");
    // the owner may act on anyone's unit
    expect((await call("POST", `/api/agents/${b.agentId}/run`, { castleId: WOOD }, owner)).status).toBe(200);
    expect((await call("POST", `/api/agents/${b.agentId}/stop`, {}, owner)).status).toBe(200);
    expect((await call("POST", `/api/agents/nope/run`, { castleId: WOOD }, owner)).status).toBe(404);
    // Bearer works too
    expect((await call("POST", `/api/agents/${a.agentId}/run`, { castleId: WOOD }, { authorization: `Bearer ${a.operatorKey}` })).status).toBe(200);
  });

  it("detail adds balance, zg usage and access; strategyText only for the operator", async () => {
    const a = await makeUnit({ strategy: "custom", strategyText: "My secret plan is long enough." });
    const anon = await call<{ agent: { strategyText?: string }; balance: string; zgUsage: { calls: number }; access: unknown }>("GET", `/api/agents/${a.agentId}`);
    expect(anon.data.agent.strategyText).toBeUndefined();
    expect(anon.data).toMatchObject({ balance: String(5 * HBAR), access: null, zgUsage: { calls: 0 } });
    const mine = await call<{ agent: { strategyText?: string }; access: string }>("GET", `/api/agents/${a.agentId}`, undefined, rk(a.operatorKey));
    expect(mine.data.agent.strategyText).toContain("secret plan");
    expect(mine.data.access).toBe("operator");
    expect(JSON.stringify(anon.data)).not.toMatch(/privateKey|private_key|zgApiKey|sk-stub|mk-test/);
  });

  it("approvals: operator keys see and decide only their units' asks; owner sees all; public sees arena units only", async () => {
    const a = await makeUnit({ name: "A" });
    const b = await makeUnit({ name: "B" });
    const arena = await createAgent({ name: "Fixture" });
    const ask = (agentId: string) => requestApproval({ agentId, castleId: WOOD, reason: "daily", reasoning: "more", amount: String(HBAR), pressure: 5 });
    const [aa, ab, ar] = await Promise.all([ask(a.agentId), ask(b.agentId), ask(arena.id)]);
    const ids = async (h: Record<string, string>) => (await call<{ approvals: { id: string }[] }>("GET", "/api/approvals", undefined, h)).data.approvals.map((x) => x.id).sort();
    expect(await ids(rk(a.operatorKey))).toEqual([aa.id]);
    expect(await ids({ "x-siege-operator-key": `${a.operatorKey},${b.operatorKey}` })).toEqual([aa.id, ab.id].sort());
    expect(await ids({})).toEqual([ar.id]);
    const owner = await ownerCookie();
    expect(await ids(owner)).toEqual([aa.id, ab.id, ar.id].sort());

    const decide = (id: string, h: Record<string, string>) => call("POST", `/api/approvals/${id}`, { decision: "approved" }, h);
    expect((await decide(ab.id, rk(a.operatorKey))).status).toBe(401); // another operator's unit
    expect((await decide(ar.id, rk(a.operatorKey))).status).toBe(401); // the arena's unit
    expect((await decide(aa.id, {})).status).toBe(401);
    expect((await decide("nope", rk(a.operatorKey))).status).toBe(401);
    expect((await decide(aa.id, rk(a.operatorKey))).status).toBe(200);
    expect((await decide(ab.id, owner)).status).toBe(200);
    expect(agentRow(a.agentId)!.status).toBe("running");
  });
});

describe("POST /api/play/start from a unit (J4)", () => {
  const start = (body: Record<string, unknown>, h: Record<string, string> = {}) => call<{ siegeId?: string; turnToken?: string; receipt?: { payer: string }; error?: string; reason?: string }>("POST", "/api/play/start", body, h);

  it("pays from the unit's own account: raider = the unit, spend settled, the siege is attributed to it", async () => {
    const u = await makeUnit({ perCastleCap: String(HBAR) });
    const r = await start({ castleId: WOOD, agentId: u.agentId }, rk(u.operatorKey));
    expect(r.status).toBe(200);
    expect(r.data.turnToken).toBeTruthy();
    const row = agentRow(u.agentId)!;
    expect(r.data.receipt?.payer).toBe(row.accountId);
    const siege = db().select().from(schema.sieges).where(eq(schema.sieges.id, r.data.siegeId!)).get()!;
    expect(siege).toMatchObject({ raider: row.accountId, agentId: u.agentId });
    expect(row.spentTinybar).toBe(50_000_000);
    expect(db().select().from(schema.agentSpend).where(eq(schema.agentSpend.agentId, u.agentId)).all().map((s) => s.state)).toEqual(["settled"]);
    expect(r.headers.get("set-cookie")).toContain(`siege_turn_${r.data.siegeId}=`);
  });

  it("without the demo path: no agentId pays as the demo raider; a wrong or missing key is 401 and charges nothing", async () => {
    const u = await makeUnit();
    const other = await makeUnit({ name: "Other" });
    expect((await start({ castleId: WOOD })).data.receipt?.payer).toBe("0.0.stub-raider");
    expect((await start({ castleId: WOOD, agentId: u.agentId }, rk(other.operatorKey))).status).toBe(401);
    expect((await start({ castleId: WOOD, agentId: u.agentId })).status).toBe(401);
    expect((await start({ castleId: WOOD, agentId: u.agentId, free: true, visitor: "visitor1" }, rk(u.operatorKey))).status).toBe(400);
    expect(agentRow(u.agentId)!.spentTinybar).toBe(0);
    expect(db().select().from(schema.agentSpend).all()).toHaveLength(0);
  });

  it("respects caps: past the per-vault cap it answers 409 cap_reached and reserves nothing", async () => {
    const u = await makeUnit({ perCastleCap: String(50_000_000) }); // exactly one op on this vault
    expect((await start({ castleId: WOOD, agentId: u.agentId }, rk(u.operatorKey))).status).toBe(200);
    const second = await start({ castleId: WOOD, agentId: u.agentId }, rk(u.operatorKey));
    expect(second.status).toBe(409);
    expect(second.data).toMatchObject({ error: "cap_reached", reason: "per_castle" });
    expect(agentRow(u.agentId)!.spentTinybar).toBe(50_000_000);
    expect(db().select().from(schema.agentSpend).where(eq(schema.agentSpend.state, "reserved")).all()).toHaveLength(0);
  });

  it("refuses a stopped or paused unit, and voids the reservation when the vault refuses the siege", async () => {
    const u = await makeUnit();
    db().update(schema.raiderAgents).set({ status: "stopped" }).where(eq(schema.raiderAgents.id, u.agentId)).run();
    expect((await start({ castleId: WOOD, agentId: u.agentId }, rk(u.operatorKey))).data.error).toBe("unit_stopped");
    db().update(schema.raiderAgents).set({ status: "paused" }).where(eq(schema.raiderAgents.id, u.agentId)).run();
    expect((await start({ castleId: WOOD, agentId: u.agentId }, rk(u.operatorKey))).data.error).toBe("awaiting_approval");
    db().update(schema.raiderAgents).set({ status: "idle" }).where(eq(schema.raiderAgents.id, u.agentId)).run();
    expect((await start({ castleId: "castle_missing", agentId: u.agentId }, rk(u.operatorKey))).status).toBe(404);
    expect(db().select().from(schema.agentSpend).all()).toHaveLength(0);
  });
});

describe("POST /api/agents/[id]/withdraw", () => {
  it("sends balance - 0.1 ℏ to the funding wallet, sets budget = spent, stops the unit", async () => {
    const u = await makeUnit();
    const r = await call<{ withdraw: { txId: string; stub?: boolean }; amount: string }>("POST", `/api/agents/${u.agentId}/withdraw`, {}, rk(u.operatorKey));
    expect(r.status).toBe(200);
    expect(r.data.amount).toBe(String(5 * HBAR - HBAR / 10));
    expect(r.data.withdraw.stub).toBe(true);
    expect(agentRow(u.agentId)).toMatchObject({ budgetTinybar: 0, spentTinybar: 0, status: "stopped" });
    // nothing left to withdraw the second time
    const again = await call<{ error: string }>("POST", `/api/agents/${u.agentId}/withdraw`, {}, rk(u.operatorKey));
    expect(again.status).toBe(409);
    expect(again.data.error).toBe("nothing_to_withdraw");
  });

  it("stub: a breach payout released to the unit is in its balance and goes out with the withdraw", async () => {
    const u = await makeUnit();
    // a broken op this unit won: pot 5 ℏ + fee 0.5 ℏ released to it
    db()
      .insert(schema.sieges)
      .values({ id: "siege_payout_x", castleId: WOOD, raider: "0.0.unit", agentId: u.agentId, status: "broken", releaseTx: "stub:release@1", releaseAmountTinybar: 5.5 * HBAR, createdAt: new Date().toISOString() } as never)
      .run();
    const d = await call<{ balance: string }>("GET", `/api/agents/${u.agentId}`, undefined, rk(u.operatorKey));
    expect(d.data.balance).toBe(String(5 * HBAR + 5.5 * HBAR));
    const r = await call<{ amount: string }>("POST", `/api/agents/${u.agentId}/withdraw`, {}, rk(u.operatorKey));
    expect(r.status).toBe(200);
    expect(r.data.amount).toBe(String(10.5 * HBAR - HBAR / 10));
    const after = await call<{ balance: string }>("GET", `/api/agents/${u.agentId}`, undefined, rk(u.operatorKey));
    expect(after.data.balance).toBe("0");
  });

  it("preconditions: not while running or paused, not with an active run or a reservation, not for arena units", async () => {
    const u = await makeUnit();
    const w = () => call<{ error: string }>("POST", `/api/agents/${u.agentId}/withdraw`, {}, rk(u.operatorKey));
    db().update(schema.raiderAgents).set({ status: "running" }).where(eq(schema.raiderAgents.id, u.agentId)).run();
    expect((await w()).data.error).toBe("unit_busy");
    db().update(schema.raiderAgents).set({ status: "paused" }).where(eq(schema.raiderAgents.id, u.agentId)).run();
    expect((await w()).data.error).toBe("unit_busy");
    db().update(schema.raiderAgents).set({ status: "idle" }).where(eq(schema.raiderAgents.id, u.agentId)).run();
    startRun(u.agentId, WOOD, 3);
    db().update(schema.raiderAgents).set({ status: "idle" }).where(eq(schema.raiderAgents.id, u.agentId)).run();
    expect((await w()).data.error).toBe("unit_busy"); // active run
    db().update(schema.agentRuns).set({ status: "stopped" }).where(eq(schema.agentRuns.agentId, u.agentId)).run();
    db().insert(schema.agentSpend).values({ id: "spend_r", agentId: u.agentId, castleId: WOOD, amountTinybar: 1, day: "2026-11-07", state: "reserved", createdAt: new Date().toISOString() }).run();
    expect((await w()).data.error).toBe("funds_reserved");
    db().delete(schema.agentSpend).run();
    expect(agentRow(u.agentId)!.budgetTinybar).toBe(5 * HBAR); // none of the refusals moved money
    const arena = await createAgent({ name: "Fixture" });
    const owner = await ownerCookie();
    expect((await call<{ error: string }>("POST", `/api/agents/${arena.id}/withdraw`, {}, owner)).data.error).toBe("not_operator_funded");
    expect((await w()).status).toBe(200);
  });
});

describe("the worker runs a red teamer's unit", () => {
  it("its model calls bill agent:<id> (never a vault, never the verifier), HBAR pays only the fee, and a hit cap radios its operator", async () => {
    const u = await makeUnit({ perCastleCap: String(HBAR) });
    startRun(u.agentId, STONE, 5);
    await agentsTick(); // pays one op from the unit, writes its 5 messages
    const row = agentRow(u.agentId)!;
    expect(row.spentTinybar).toBe(HBAR); // fee only: compute is credits, not HBAR
    const sieges = db().select().from(schema.sieges).where(eq(schema.sieges.agentId, u.agentId)).all();
    expect(sieges).toHaveLength(1);
    expect(sieges[0].raider).toBe(row.accountId);
    const recs = db().select().from(schema.proxyRecords).where(eq(schema.proxyRecords.billedTo, `agent:${u.agentId}`)).all();
    expect(recs.length).toBeGreaterThanOrEqual(1);
    expect(recs.every((r) => r.siegeId === `agent_${u.agentId}` && !r.protectedToolCalled)).toBe(true);
    // the second op hits the per-vault cap: the unit pauses and asks (visible to its own key)
    await agentsTick();
    expect(agentRow(u.agentId)!.status).toBe("paused");
    const asks = await call<{ approvals: { reason: string; agentId: string }[] }>("GET", "/api/approvals", undefined, rk(u.operatorKey));
    expect(asks.data.approvals).toMatchObject([{ reason: "per_castle", agentId: u.agentId }]);
  });

  it("a rejected 0G key pauses the unit with a zg_key ask and the siege still finishes on scripted lines", async () => {
    const u = await makeUnit();
    process.env.ZG_CONNECT_MOCK = "0";
    db().update(schema.raiderAgents).set({ zgApiKey: "sk-real-rejected" }).where(eq(schema.raiderAgents.id, u.agentId)).run();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "invalid key" }), { status: 401 }));
    startRun(u.agentId, STONE, 5);
    await agentsTick();
    expect(agentRow(u.agentId)!.status).toBe("paused");
    const asks = await call<{ approvals: { reason: string }[] }>("GET", "/api/approvals", undefined, rk(u.operatorKey));
    expect(asks.data.approvals.map((a) => a.reason)).toEqual(["zg_key"]);
    const siege = db().select().from(schema.sieges).where(eq(schema.sieges.agentId, u.agentId)).get()!;
    expect(siege.turn).toBeGreaterThan(0); // the paid op was not stranded
    expect(db().select().from(schema.proxyRecords).where(eq(schema.proxyRecords.billedTo, `agent:${u.agentId}`)).all()).toHaveLength(0);
  });
});
