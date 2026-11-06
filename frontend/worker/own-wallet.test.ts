/**
 * Every paid op is paid from the operator's OWN account (Dhruv's decision, 2026-11-07), through the real
 * routes in stub mode with the testnet rule switched on (DEMO_WALLET_OPS=0):
 *   - POST /api/play/start: a paid op with no unit -> 403 own_account_required, nothing charged; recon stays free;
 *     with a unit + its key -> paid from the unit; a wrong key -> 401
 *   - DEMO_WALLET_OPS is stub-only: on by default in stub, "0" turns it off; testnet refuses "1" at boot
 *   - POST /api/agents {kind:"manual"}: an operator account with no 0G key and no strategy, funded by the memo
 *     deposit (stub confirms inline), caps = its budget; a unit without a 0G key is refused; the owner cookie
 *     never turns it into an arena-funded unit
 *   - an operator account spends what it holds: short -> 409 cap_reached {manual, balance, fee}; a breach
 *     payout is spendable past the deposit; no name -> a callsign, never "Unit"
 *   - DEPLOY on an operator account -> 409 needs_0g
 *   - the whole J4 walk: operator account -> hand-typed op on Splinter Gate -> breach -> payout in the account -> withdraw
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { eq } from "drizzle-orm";
import { demoWalletOps, env, resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { agentRow } from "@/lib/agents/accounts";
import { createUnitDraft, getUnitDraft, UnitDraftRejected } from "@/lib/agents/drafts";
import { CALLSIGNS } from "@/lib/agents/manual";
import { HBAR, makeUnit, setupUnitsEnv } from "@/lib/agents/units.test-util";
import { WOODEN_BREAK } from "@/lib/fixtures/raids";
import { createInProcessFetch } from "./dispatch";
import { setFetch } from "./fetch";
import { settleTick } from "./settle";
import { setWorkerQuiet } from "./log";

setWorkerQuiet(true);
const BASE = "http://localhost:3000";
const f = createInProcessFetch(BASE);
const WOOD = "castle_splinter_gate";

setupUnitsEnv();
beforeEach(() => {
  process.env.DEMO_WALLET_OPS = "0";
  resetEnv();
});
afterEach(() => {
  delete process.env.DEMO_WALLET_OPS;
  resetEnv();
});
setFetch(f);
afterAll(() => setFetch(null));

const turnTokens = new Map<string, string>();
async function call<T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}) {
  const token = turnTokens.get(/^\/api\/siege\/([^/]+)\/message$/.exec(path)?.[1] ?? "");
  const res = await f(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { "x-siege-turn-token": token } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => null)) as T;
  const started = data as { siegeId?: string; turnToken?: string } | null;
  if (started?.siegeId && started.turnToken) turnTokens.set(started.siegeId, started.turnToken);
  return { status: res.status, data, headers: res.headers };
}
const rk = (k: string) => ({ "x-siege-operator-key": k });
type StartRes = { siegeId?: string; turnToken?: string; receipt?: { payer: string }; error?: string; message?: string };
const start = (body: Record<string, unknown>, h: Record<string, string> = {}) => call<StartRes>("POST", "/api/play/start", body, h);
async function ownerCookie(): Promise<Record<string, string>> {
  const res = await f(`${BASE}/api/owner`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: env().OWNER_SECRET }) });
  return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
}

/** An operator account through the real route: POST /api/agents {kind:"manual"} (stub deposit confirms inline). */
async function openAccount(budget = 5 * HBAR, name = "Glass Fox", headers: Record<string, string> = {}) {
  const r = await call<{ draft: { id: string; state: string; strategy: string }; operatorKey: string; deposit: { memo: string } }>(
    "POST",
    "/api/agents",
    { kind: "manual", name, budget: String(budget) },
    headers,
  );
  expect(r.status).toBe(201);
  const agentId = getUnitDraft(r.data.draft.id)!.agentId!;
  expect(agentId).toBeTruthy();
  return { ...r.data, agentId };
}

describe("DEMO_WALLET_OPS", () => {
  it("is stub-only: on by default in stub, 0 turns it off; testnet is always off and refuses 1 at boot", () => {
    const secret = process.env.OWNER_SECRET;
    try {
      delete process.env.DEMO_WALLET_OPS;
      resetEnv();
      expect(demoWalletOps()).toBe(true);
      for (const [v, on] of [["true", true], ["off", false], ["0", false], ["1", true]] as const) {
        process.env.DEMO_WALLET_OPS = v;
        resetEnv();
        expect(demoWalletOps()).toBe(on);
      }
      process.env.DEMO_WALLET_OPS = "maybe";
      resetEnv();
      expect(() => env()).toThrow(/DEMO_WALLET_OPS must be 0 or 1/);

      process.env.CHAIN_MODE = "testnet";
      process.env.OWNER_SECRET = "a-private-testnet-secret";
      delete process.env.DEMO_WALLET_OPS;
      resetEnv();
      expect(demoWalletOps()).toBe(false);
      process.env.DEMO_WALLET_OPS = "0";
      resetEnv();
      expect(demoWalletOps()).toBe(false);
      for (const v of ["1", "true"]) {
        process.env.DEMO_WALLET_OPS = v;
        resetEnv();
        expect(() => env()).toThrow(/DEMO_WALLET_OPS=1 is stub-only/);
      }
    } finally {
      process.env.CHAIN_MODE = "stub";
      process.env.OWNER_SECRET = secret;
      process.env.DEMO_WALLET_OPS = "0";
      resetEnv();
    }
  });

  it("GET /api/config tells the browser whether the demo wallet still pays", async () => {
    expect((await call<{ demoWalletOps: boolean; unitMinBudget: string }>("GET", "/api/config")).data).toMatchObject({ demoWalletOps: false, unitMinBudget: String(HBAR) });
    delete process.env.DEMO_WALLET_OPS;
    resetEnv();
    expect((await call<{ demoWalletOps: boolean }>("GET", "/api/config")).data.demoWalletOps).toBe(true);
  });
});

describe("POST /api/play/start: own account only (DEMO_WALLET_OPS=0)", () => {
  it("a paid op with no unit is 403 own_account_required and charges nothing; free recon still starts", async () => {
    const r = await start({ castleId: WOOD });
    expect(r.status).toBe(403);
    expect(r.data.error).toBe("own_account_required");
    expect(r.data.message).toMatch(/own account/);
    expect(db().select().from(schema.paymentReceipts).all()).toHaveLength(0);
    expect(db().select().from(schema.sieges).all()).toHaveLength(0);

    const recon = await start({ castleId: WOOD, free: true, visitor: "visitor1" }, { "x-forwarded-for": "4.4.4.4" });
    expect(recon.status).toBe(200);
    expect(recon.data.receipt?.payer).toBe("recon-visitor1");
  });

  it("with a unit + its key it pays from the unit; a wrong or missing key is 401", async () => {
    const u = await makeUnit();
    const other = await makeUnit({ name: "Other" });
    const ok = await start({ castleId: WOOD, agentId: u.agentId }, rk(u.operatorKey));
    expect(ok.status).toBe(200);
    expect(ok.data.receipt?.payer).toBe(agentRow(u.agentId)!.accountId);
    expect((await start({ castleId: WOOD, agentId: u.agentId }, rk(other.operatorKey))).status).toBe(401);
    expect((await start({ castleId: WOOD, agentId: u.agentId })).status).toBe(401);
    expect(agentRow(other.agentId)!.spentTinybar).toBe(0);
  });

  it("the stub hatch (DEMO_WALLET_OPS=1) keeps the old demo-wallet path", async () => {
    process.env.DEMO_WALLET_OPS = "1";
    resetEnv();
    const r = await start({ castleId: WOOD });
    expect(r.status).toBe(200);
    expect(r.data.receipt?.payer).toBe("0.0.stub-raider");
  });
});

describe("operator account (POST /api/agents kind manual)", () => {
  it("needs no 0G key and no strategy: deposit -> account with caps = budget, no stop rule, no 0G", async () => {
    const a = await openAccount(5 * HBAR);
    expect(a.operatorKey).toMatch(/^rk_/);
    expect(a.deposit.memo).toMatch(/^siege:/);
    expect(a.draft).toMatchObject({ state: "created", strategy: "manual" });
    const row = agentRow(a.agentId)!;
    expect(row).toMatchObject({
      name: "Glass Fox",
      strategy: "manual",
      fundedBy: "operator",
      budgetTinybar: 5 * HBAR,
      perCastleCapTinybar: 5 * HBAR,
      dailyCapTinybar: 5 * HBAR,
      stopAfterLosses: 0,
      strategyText: null,
      zgApiKey: null,
      zgMgmtKey: null,
    });
    const mine = await call<{ agents: { id: string; balance?: string; zg?: unknown }[] }>("GET", "/api/agents?mine=1", undefined, rk(a.operatorKey));
    expect(mine.data.agents).toEqual([expect.objectContaining({ id: a.agentId, balance: String(5 * HBAR) })]);
    expect(mine.data.agents[0].zg).toBeUndefined();
  });

  it("refuses below UNIT_MIN_BUDGET; a unit (not manual) without a 0G key is refused with zg_key_required", async () => {
    const low = await call<{ error: string }>("POST", "/api/agents", { kind: "manual", budget: String(HBAR / 2) });
    expect([low.status, low.data.error]).toEqual([400, "budget_too_small"]);
    const unit = await call<{ error: string }>("POST", "/api/agents", { name: "NoBrain", budget: String(2 * HBAR) });
    expect([unit.status, unit.data.error]).toEqual([400, "zg_key_required"]);
    await expect(createUnitDraft({ budget: String(2 * HBAR) })).rejects.toBeInstanceOf(UnitDraftRejected);
  });

  it("opened without a callsign it gets one (never \"Unit\")", async () => {
    const r = await call<{ draft: { id: string } }>("POST", "/api/agents", { kind: "manual", budget: String(2 * HBAR) });
    expect(r.status).toBe(201);
    const name = agentRow(getUnitDraft(r.data.draft.id)!.agentId!)!.name;
    expect(CALLSIGNS as readonly string[]).toContain(name);
  });

  it("spends what it holds: short of the fee it is 409 cap_reached {manual, balance, fee}, nothing charged", async () => {
    const a = await openAccount(HBAR);
    expect((await start({ castleId: WOOD, agentId: a.agentId }, rk(a.operatorKey))).status).toBe(200);
    expect((await start({ castleId: WOOD, agentId: a.agentId }, rk(a.operatorKey))).status).toBe(200);
    const third = await start({ castleId: WOOD, agentId: a.agentId }, rk(a.operatorKey));
    expect(third.status).toBe(409);
    expect(third.data).toMatchObject({ error: "cap_reached", reason: "budget", manual: true, balance: "0", fee: String(HBAR / 2) });
    expect(agentRow(a.agentId)!.spentTinybar).toBe(HBAR);
    expect(db().select().from(schema.agentSpend).all().filter((r) => r.state !== "void")).toHaveLength(2);
  });

  it("the owner cookie does not turn it into an arena-funded unit", async () => {
    const a = await openAccount(2 * HBAR, "Owner Device", await ownerCookie());
    expect(agentRow(a.agentId)).toMatchObject({ fundedBy: "operator", strategy: "manual" });
  });

  it("DEPLOY is refused: 409 needs_0g, nothing queued", async () => {
    const a = await openAccount();
    const r = await call<{ error: string; message: string }>("POST", `/api/agents/${a.agentId}/run`, { castleId: WOOD }, rk(a.operatorKey));
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("needs_0g");
    expect(r.data.message).toMatch(/Connect 0G to let it run on its own/);
    expect(agentRow(a.agentId)!.status).toBe("idle");
    expect(db().select().from(schema.agentRuns).all()).toHaveLength(0);
  });

  it("J4 end to end: a hand-typed op paid from it breaks Splinter Gate, the payout lands in it, WITHDRAW sends it home", async () => {
    const { seed } = await import("@/scripts/seed");
    await seed({ quiet: true });
    const a = await openAccount(5 * HBAR);
    const acct = agentRow(a.agentId)!.accountId;

    const op = await start({ castleId: WOOD, agentId: a.agentId }, rk(a.operatorKey));
    expect(op.status).toBe(200);
    expect(op.data.receipt?.payer).toBe(acct);
    const id = op.data.siegeId!;
    let status = "in_progress";
    for (const text of WOODEN_BREAK) {
      const m = await call<{ siege: { status: string } }>("POST", `/api/siege/${id}/message`, { text });
      expect(m.status).toBe(200);
      status = m.data.siege.status;
      if (status !== "in_progress") break;
    }
    expect(status).toBe("broken");
    await settleTick();

    const siege = db().select().from(schema.sieges).where(eq(schema.sieges.id, id)).get()!;
    expect(siege).toMatchObject({ raider: acct, agentId: a.agentId });
    expect(siege.releaseTx).toBeTruthy();
    const payout = siege.releaseAmountTinybar!;
    expect(payout).toBeGreaterThan(0);

    const d = await call<{ balance: string }>("GET", `/api/agents/${a.agentId}`, undefined, rk(a.operatorKey));
    expect(d.data.balance).toBe(String(5 * HBAR - 50_000_000 + payout));
    // The winnings are spendable: its deposit was 5 ℏ, and three 2 ℏ ops take it past that (no per-vault/daily cap).
    const IRON = "castle_iron_warden";
    expect(5 * HBAR - 50_000_000 + payout).toBeGreaterThan(6 * HBAR + 50_000_000);
    for (let i = 0; i < 3; i++) {
      const r = await start({ castleId: IRON, agentId: a.agentId }, rk(a.operatorKey));
      expect([r.status, r.data.error]).toEqual([200, undefined]);
      db().update(schema.sieges).set({ status: "held" }).where(eq(schema.sieges.id, r.data.siegeId!)).run();
    }
    expect(agentRow(a.agentId)!.spentTinybar).toBe(50_000_000 + 6 * HBAR);
    // The ops ended (marked held above) and nothing is reserved: withdraw what is left.
    const left = BigInt((await call<{ balance: string }>("GET", `/api/agents/${a.agentId}`, undefined, rk(a.operatorKey))).data.balance);
    const w = await call<{ amount: string; error?: string }>("POST", `/api/agents/${a.agentId}/withdraw`, {}, rk(a.operatorKey));
    expect([w.status, w.data.error]).toEqual([200, undefined]);
    expect(left).toBe(BigInt(5 * HBAR - 50_000_000 + payout - 6 * HBAR));
    expect(w.data.amount).toBe(String(left - BigInt(HBAR / 10)));
  });
});
