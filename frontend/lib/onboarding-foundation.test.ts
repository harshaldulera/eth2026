/**
 * Onboarding foundation (plans/siege-onboarding-plan.md §0): migration 0007 shape, defaults that keep
 * fixtures working, and toCastle/toAgent exposing only the cheap public fields (never keys/orders/results).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { toAgent } from "@/lib/agents/accounts";
import { castleRow, toCastle, toolNamesOf } from "@/lib/castles";
import { env, resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";

type Sqlite = { prepare: (s: string) => { all: () => unknown[] } };
const raw = () => (db() as unknown as { $client: Sqlite }).$client;
const cols = (table: string) => (raw().prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

const SECRET_TOOLS = JSON.stringify([
  { name: "lookup_order", description: "secret-desc", parameters: { type: "object" }, result: { internal: "SECRET_RESULT_42" } },
  { name: "issue_refund", description: "pays", parameters: { type: "object" } },
]);

beforeEach(() => {
  freshFixtureDb();
});

describe("migration 0007_onboarding", () => {
  it("adds the castle, agent, approval, proxy and siege columns", () => {
    expect(cols("castles")).toEqual(
      expect.arrayContaining([
        "published", "blurb", "tools", "owner_key_hash", "deposit_tx", "zg_api_key", "zg_mgmt_key", "zg_key_id",
        "guard_key", "vault_key", "lease_id", "lease_meta", "pinned_prompt_hash", "prompt_drift_hash", "self_check_at", "smoke_result",
      ]),
    );
    expect(cols("raider_agents")).toEqual(
      expect.arrayContaining(["operator_key_hash", "strategy_text", "funded_by", "deposit_tx", "zg_api_key", "zg_mgmt_key", "zg_key_id"]),
    );
    expect(cols("approval_requests")).toContain("deposit_intent_id");
    expect(cols("proxy_records")).toContain("billed_to");
    expect(cols("sieges")).toContain("turn_token_hash");
  });

  it("creates the new tables", () => {
    expect(cols("deposit_intents")).toEqual(
      expect.arrayContaining(["id", "kind", "ref_id", "code", "memo", "amount_tinybar", "payer_filter", "state", "received_tinybar", "txs", "payer", "note", "attempts", "error", "created_at", "expires_at", "funded_at"]),
    );
    expect(cols("vault_drafts")).toEqual(["id", "castle_id", "intent_id", "form", "owner_key_hash", "fee_tinybar", "days", "created_at"]);
    expect(cols("unit_drafts")).toEqual(expect.arrayContaining(["id", "intent_id", "operator_key_hash", "state", "agent_id", "zg_api_key"]));
    expect(cols("guard_turns")).toEqual(
      expect.arrayContaining(["id", "castle_id", "kind", "siege_id", "turn", "messages_json", "state", "lease_id", "reply_json", "request_id", "claimed_at", "answered_at", "created_at"]),
    );
    expect(cols("operators")).toEqual(["account", "handle", "created_at"]);
  });

  it("fixture castles get the defaults; guard/vault keys and intent codes are unique", () => {
    const row = db().select().from(schema.castles).get()!;
    expect(row.published).toBe(false);
    expect(row.ownerKeyHash).toBeNull();
    const ids = db().select({ id: schema.castles.id }).from(schema.castles).all().map((r) => r.id);
    // Several NULL guard keys are fine; two equal ones are not.
    db().update(schema.castles).set({ guardKey: "gk_same" }).where(eq(schema.castles.id, ids[0]!)).run();
    expect(() => db().update(schema.castles).set({ guardKey: "gk_same" }).where(eq(schema.castles.id, ids[1]!)).run()).toThrow(/UNIQUE/);
    const intent = { kind: "vault" as const, refId: "r", memo: "siege:abcdefgh", amountTinybar: 1, createdAt: "now", expiresAt: "later" };
    db().insert(schema.depositIntents).values({ ...intent, id: "di_1", code: "abcdefgh" }).run();
    expect(() => db().insert(schema.depositIntents).values({ ...intent, id: "di_2", code: "abcdefgh" }).run()).toThrow(/UNIQUE/);
    const di = db().select().from(schema.depositIntents).where(eq(schema.depositIntents.id, "di_1")).get()!;
    expect(di).toMatchObject({ state: "awaiting", receivedTinybar: 0, txs: "[]", attempts: 0 });
  });
});

describe("toCastle / toAgent onboarding fields", () => {
  it("a fixture castle carries none of them", () => {
    const c = toCastle(db().select().from(schema.castles).get()!);
    for (const k of ["published", "blurb", "toolNames", "zg", "sdk", "earnings"]) expect(c).not.toHaveProperty(k);
  });

  it("a published castle exposes published, blurb, tool names and zg kind — never keys, orders or results", () => {
    const id = db().select({ id: schema.castles.id }).from(schema.castles).get()!.id;
    db()
      .update(schema.castles)
      .set({
        published: true,
        blurb: "Penny runs refunds",
        tools: SECRET_TOOLS,
        ownerKeyHash: "hash_should_not_leak",
        zgApiKey: "sk-SECRET_API",
        zgMgmtKey: "mk-SECRET_MGMT",
        zgKeyId: "zgkey_SECRET",
        guardKey: "gk_SECRET_GUARD",
        vaultKey: "vk_SECRET_VAULT",
        leaseId: "lease_SECRET",
      })
      .where(eq(schema.castles.id, id))
      .run();
    const row = castleRow(id)!;
    const c = toCastle(row);
    expect(c.published).toBe(true);
    expect(c.blurb).toBe("Penny runs refunds");
    expect(c.toolNames).toEqual(["lookup_order", "issue_refund"]);
    expect(c.zg).toEqual({ connected: true, kind: "mk" });
    const out = JSON.stringify(c);
    for (const s of ["SECRET", "secret-desc", "hash_should_not_leak", row.orders]) expect(out).not.toContain(s);
    expect(toCastle({ ...row, zgMgmtKey: null }).zg).toEqual({ connected: true, kind: "sk" });
  });

  it("toolNamesOf tolerates absent or malformed JSON", () => {
    expect(toolNamesOf(null)).toEqual([]);
    expect(toolNamesOf("not json")).toEqual([]);
    expect(toolNamesOf('{"name":"x"}')).toEqual([]);
    expect(toolNamesOf('[{"name":"a"},{"nope":1},null,{"name":2}]')).toEqual(["a"]);
  });

  it("toAgent: fundedBy always, hasOperatorKey/zg when set, never keys or strategyText", () => {
    const base = {
      id: "agent_x", name: "Vex", ownerId: "owner", strategy: "authority", accountId: "0.0.stub-agent-x",
      budgetTinybar: 100, perCastleCapTinybar: 10, dailyCapTinybar: 50, createdAt: "now",
    };
    db().insert(schema.raiderAgents).values(base).run();
    const plain = toAgent(db().select().from(schema.raiderAgents).get()!);
    expect(plain.fundedBy).toBe("arena");
    expect(plain).not.toHaveProperty("hasOperatorKey");
    expect(plain).not.toHaveProperty("zg");

    db()
      .update(schema.raiderAgents)
      .set({ fundedBy: "operator", operatorKeyHash: "hash_SECRET", strategyText: "SECRET_STRATEGY", zgApiKey: "sk-SECRET", privateKey: "0xSECRET" })
      .run();
    const a = toAgent(db().select().from(schema.raiderAgents).get()!);
    expect(a).toMatchObject({ fundedBy: "operator", hasOperatorKey: true, zg: { connected: true, kind: "sk" } });
    expect(JSON.stringify(a)).not.toContain("SECRET");
  });
});

describe("onboarding env defaults", () => {
  it("has the plan's defaults, and ZG_ROUTER_URL falls back to ZG_BASE_URL", () => {
    const saved = { router: process.env.ZG_ROUTER_URL, base: process.env.ZG_BASE_URL };
    try {
      delete process.env.ZG_ROUTER_URL;
      delete process.env.ZG_BASE_URL;
      resetEnv();
      const e = env();
      expect(e.PUBLISH_MAX_POT).toBe(100 * 100_000_000);
      expect(e.PUBLISH_MAX_OPEN_DRAFTS).toBe(20);
      expect(e.DEPOSIT_WINDOW_MIN).toBe(45);
      expect(e.FREE_RECON_PER_IP_PER_DAY).toBe(25);
      expect(e.FREE_RECON_PER_DAY_TOTAL).toBe(400);
      expect(e.AGENT_MAX_COUNT).toBe(100);
      expect(e.UNIT_MIN_BUDGET).toBe(100_000_000);
      expect(e.ZG_ROUTER_URL).toBe("https://router-api.0g.ai/v1");
      process.env.ZG_BASE_URL = "http://base.local/v1/";
      resetEnv();
      expect(env().ZG_ROUTER_URL).toBe("http://base.local/v1");
      process.env.ZG_ROUTER_URL = "http://router.local/v1";
      resetEnv();
      expect(env().ZG_ROUTER_URL).toBe("http://router.local/v1");
    } finally {
      if (saved.router === undefined) delete process.env.ZG_ROUTER_URL;
      else process.env.ZG_ROUTER_URL = saved.router;
      if (saved.base === undefined) delete process.env.ZG_BASE_URL;
      else process.env.ZG_BASE_URL = saved.base;
      resetEnv();
    }
  });
});
