/** lib/zg/connect: 0G key kinds, connect/probe against a mocked router, balance, usage, stub mode. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import {
  clearZgBalanceCache,
  connectZg,
  detectKind,
  keyName,
  parseBalance,
  parseCreatedKey,
  probeZg,
  revokeZg,
  STUB_KEY_PREFIX,
  stubBalance,
  zgBalance,
  zgConnectMock,
  zgUsage,
} from "./connect";
import { billingFor, needsUserBilling, requireUserBilling, ZgNotConnectedError } from "./billing";

const ROUTER = "https://router-api.0g.ai/v1";
const MK = "mk-test-management-key";
const SK = "sk-test-inference-key";

type Route = { status: number; body?: unknown } | "throw";
type Call = { url: string; method: string; auth: string | null; body: unknown };

/** Mock the router: "<METHOD> <path>" → response. Records every call. */
function router(routes: Record<string, Route>): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({ url, method, auth: headers.get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const path = url.replace(ROUTER, "");
    const r = routes[`${method} ${path}`];
    if (!r) return new Response("{}", { status: 404 });
    if (r === "throw") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  });
  return calls;
}

const BALANCE = { status: 200, body: { address: "0xabc", total_balance: "2500000000000000000", deposit_balance: "1000000000000000000" } };
const MODELS = { status: 200, body: { object: "list", data: [{ id: "qwen3.7-flash" }, { id: "gpt-5.4-mini" }] } };
const CREATED = { status: 200, body: { key: "sk-minted-secret", key_id: "abc12345", key_preview: "sk-min…", name: "siege:castle_x" } };

function useRealRouter() {
  process.env.ZG_CONNECT_MOCK = "0";
}

beforeEach(() => {
  freshFixtureDb();
  clearZgBalanceCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ZG_CONNECT_MOCK;
});

describe("detectKind", () => {
  it("tells mk- from sk- and rejects anything else", () => {
    expect(detectKind("mk-abc")).toBe("mk");
    expect(detectKind("  sk-abc  ")).toBe("sk");
    expect(detectKind("sk-")).toBeNull();
    expect(detectKind("pk-abc")).toBeNull();
    expect(detectKind("sk-has space")).toBeNull();
    expect(detectKind("")).toBeNull();
    expect(detectKind(null)).toBeNull();
    expect(detectKind(`sk-${"a".repeat(600)}`)).toBeNull();
  });

  it("names minted keys siege:<label>, tidy", () => {
    expect(keyName("castle_abc")).toBe("siege:castle_abc");
    expect(keyName("agent x/y")).toBe("siege:agent-x-y");
  });
});

describe("router response parsing (defensive)", () => {
  it("reads total_balance in neuron, USD micro, plain decimals and deposit+credit", () => {
    expect(parseBalance(BALANCE.body)).toBe("2.5");
    expect(parseBalance({ total_balance: "12345678", currency: "usd" })).toBe("12.3457");
    expect(parseBalance({ balance: "7.25" })).toBe("7.25");
    expect(parseBalance({ deposit_balance: "1000000000000000000", credit_balance: "271000000000000000" })).toBe("1.271");
    expect(parseBalance({ data: { total_balance: "3000000000000000000" } })).toBe("3");
    expect(parseBalance({ nothing: true })).toBeNull();
  });

  it("finds the created key's secret and id under any common field name", () => {
    expect(parseCreatedKey(CREATED.body)).toEqual({ key: "sk-minted-secret", keyId: "abc12345" });
    expect(parseCreatedKey({ data: { api_key: "sk-x", id: 42 } })).toEqual({ key: "sk-x", keyId: "42" });
    expect(parseCreatedKey({ secret: "sk-y", keyId: "k1" })).toEqual({ key: "sk-y", keyId: "k1" });
    expect(parseCreatedKey({ key_preview: "sk-…" })).toEqual({ key: null, keyId: null });
  });
});

describe("connectZg (mocked router)", () => {
  beforeEach(useRealRouter);

  it("mk-: reads the balance, mints a dedicated sk- named siege:<label>", async () => {
    const calls = router({ "GET /account/balance": BALANCE, "POST /api-keys": CREATED, "GET /models": MODELS });
    const r = await connectZg({ key: MK, label: "castle_x" });
    expect(r).toEqual({
      ok: true,
      kind: "mk",
      balance: "2.5",
      inferenceKey: "sk-minted-secret",
      keyId: "abc12345",
      mgmtKey: MK,
      models: ["qwen3.7-flash", "gpt-5.4-mini"],
      model: "gpt-5.4-mini",
      mock: false,
    });
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe(`${ROUTER}/api-keys`);
    expect(post.auth).toBe(`Bearer ${MK}`);
    expect(post.body).toEqual({ name: "siege:castle_x" });
    // Balance read happens before the mint (no orphan key when account:read is missing).
    expect(calls.map((c) => `${c.method} ${c.url.replace(ROUTER, "")}`).slice(0, 2)).toEqual(["GET /account/balance", "POST /api-keys"]);
  });

  it("mk-: 401 → unauthorized, nothing minted", async () => {
    const calls = router({ "GET /account/balance": { status: 401, body: { error: { code: "invalid_api_key" } } } });
    expect(await connectZg({ key: MK, label: "c" })).toEqual({ ok: false, reason: "unauthorized" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("mk- without account:read → needs_account_read, nothing minted", async () => {
    const calls = router({ "GET /account/balance": { status: 403, body: { error: { code: "insufficient_scope" } } } });
    expect(await connectZg({ key: MK, label: "c" })).toEqual({ ok: false, reason: "needs_account_read" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("mk- without keys:create → needs_keys_create", async () => {
    router({ "GET /account/balance": BALANCE, "POST /api-keys": { status: 403, body: { error: { code: "insufficient_scope" } } } });
    expect(await connectZg({ key: MK, label: "c" })).toEqual({ ok: false, reason: "needs_keys_create" });
  });

  it("created key without a readable secret is revoked, reported unreachable", async () => {
    const calls = router({ "GET /account/balance": BALANCE, "POST /api-keys": { status: 200, body: { key_id: "orphan1" } }, "DELETE /api-keys/orphan1": { status: 200 } });
    expect(await connectZg({ key: MK, label: "c" })).toEqual({ ok: false, reason: "unreachable" });
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/api-keys/orphan1"))).toBe(true);
  });

  it("router down → unreachable (no mock fallback with ZG_CONNECT_MOCK=0)", async () => {
    router({ "GET /account/balance": "throw", "GET /models": "throw" });
    expect(await connectZg({ key: MK, label: "c" })).toEqual({ ok: false, reason: "unreachable" });
    expect(await connectZg({ key: SK, label: "c" })).toEqual({ ok: false, reason: "unreachable" });
  });

  it("sk-: /models probe + account probe (403 = live inference key) → used as is", async () => {
    const calls = router({ "GET /models": MODELS, "GET /account/balance": { status: 403, body: { error: { code: "insufficient_scope" } } } });
    const r = await connectZg({ key: SK, label: "agent_1" });
    expect(r).toEqual({ ok: true, kind: "sk", inferenceKey: SK, models: ["qwen3.7-flash", "gpt-5.4-mini"], model: "gpt-5.4-mini", mock: false });
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(calls.every((c) => c.auth === `Bearer ${SK}`)).toBe(true);
  });

  it("sk-: a public /models but 401 on the account probe → unauthorized", async () => {
    router({ "GET /models": MODELS, "GET /account/balance": { status: 401 } });
    expect(await connectZg({ key: SK, label: "a" })).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("not an mk-/sk- key → unauthorized without any network call", async () => {
    const calls = router({});
    expect(await connectZg({ key: "hello", label: "a" })).toEqual({ ok: false, reason: "unauthorized" });
    expect(calls).toHaveLength(0);
  });
});

describe("probeZg (validate route) never mints", () => {
  beforeEach(useRealRouter);

  it("mk-: balance + public model list, no POST, mk- never sent to /models", async () => {
    const calls = router({ "GET /account/balance": BALANCE, "GET /models": MODELS });
    expect(await probeZg({ key: MK })).toEqual({ ok: true, kind: "mk", balance: "2.5", models: ["qwen3.7-flash", "gpt-5.4-mini"], model: "gpt-5.4-mini", mock: false });
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
    expect(calls.find((c) => c.url.endsWith("/models"))?.auth).toBeNull();
  });

  it("mk- missing account:read → needs_account_read", async () => {
    router({ "GET /account/balance": { status: 403 } });
    expect(await probeZg({ key: MK })).toEqual({ ok: false, reason: "needs_account_read" });
  });
});

describe("revokeZg and zgBalance", () => {
  beforeEach(useRealRouter);

  it("revoke: DELETE /api-keys/:id with the mk-, best effort", async () => {
    const calls = router({ "DELETE /api-keys/abc12345": { status: 200, body: { key_id: "abc12345", message: "API key revoked" } } });
    expect(await revokeZg({ mgmtKey: MK, keyId: "abc12345" })).toBe(true);
    expect(calls[0]).toMatchObject({ method: "DELETE", auth: `Bearer ${MK}` });
    vi.restoreAllMocks();
    router({ "DELETE /api-keys/x": "throw" });
    expect(await revokeZg({ mgmtKey: MK, keyId: "x" })).toBe(false);
    expect(await revokeZg({ mgmtKey: null, keyId: "x" })).toBe(false);
  });

  it("balance: mk- only, cached for 15 s", async () => {
    const calls = router({ "GET /account/balance": BALANCE });
    expect(await zgBalance({ mgmtKey: MK })).toBe("2.5");
    expect(await zgBalance({ mgmtKey: MK })).toBe("2.5");
    expect(calls).toHaveLength(1);
    expect(await zgBalance({ mgmtKey: SK })).toBeNull();
    expect(await zgBalance({ mgmtKey: null })).toBeNull();
  });
});

function recordCall(billedTo: string, costUsdMicro: string | null, at = new Date().toISOString()) {
  db()
    .insert(schema.proxyRecords)
    .values({
      requestId: `req-${Math.random().toString(36).slice(2)}`,
      castleId: "castle_x",
      model: "gpt-5.4-mini",
      promptHash: "p",
      responseHash: "r",
      protectedToolCalled: false,
      toolCalls: "[]",
      costUsdMicro,
      at,
      billedTo,
    })
    .run();
}

describe("zgUsage", () => {
  it("counts calls and sums cost per billed_to, today and all time", () => {
    recordCall("castle:castle_x", "1500");
    recordCall("castle:castle_x", "2500");
    recordCall("castle:castle_x", null);
    recordCall("castle:castle_x", "1000", "2025-01-01T00:00:00.000Z");
    recordCall("agent:a1", "9999");
    recordCall("team", "5");
    expect(zgUsage("castle:castle_x")).toEqual({ calls: 4, costUsdMicro: "5000", today: { calls: 3, costUsdMicro: "4000" } });
    expect(zgUsage("agent:a1")).toEqual({ calls: 1, costUsdMicro: "9999", today: { calls: 1, costUsdMicro: "9999" } });
    expect(zgUsage("castle:none")).toEqual({ calls: 0, costUsdMicro: "0", today: { calls: 0, costUsdMicro: "0" } });
  });
});

describe("mock mode (stub demo)", () => {
  it("is on in tests by default (no team key / GUARDIAN_MODE=stub), off with ZG_CONNECT_MOCK=0", () => {
    expect(zgConnectMock()).toBe(true);
    process.env.ZG_CONNECT_MOCK = "0";
    expect(zgConnectMock()).toBe(false);
  });

  it("accepts any mk-/sk- key without the network; mk- mints a deterministic stub sk-", async () => {
    const calls = router({});
    const a = await connectZg({ key: MK, label: "castle_x" });
    const b = await connectZg({ key: MK, label: "castle_x" });
    expect(a).toEqual(b);
    expect(a.ok && a.kind === "mk" && a.inferenceKey.startsWith(STUB_KEY_PREFIX)).toBe(true);
    expect(a.ok && a.mock).toBe(true);
    expect(await connectZg({ key: SK, label: "u" })).toMatchObject({ ok: true, kind: "sk", inferenceKey: SK, mock: true });
    expect(await probeZg({ key: "nope" })).toEqual({ ok: false, reason: "unauthorized" });
    expect(await revokeZg({ mgmtKey: MK, keyId: "stub_1" })).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("the stub balance drops by every call billed to that guard", async () => {
    const before = Number(await zgBalance({ mgmtKey: MK, billedTo: "castle:castle_x" }));
    expect(before).toBeGreaterThanOrEqual(20);
    recordCall("castle:castle_x", "12000");
    recordCall("castle:castle_x", "12000");
    const after = Number(await zgBalance({ mgmtKey: MK, billedTo: "castle:castle_x" }));
    expect(after).toBeCloseTo(before - 0.024, 4);
    expect(stubBalance(MK)).toBe(String(before));
  });

  it("falls back to mock in CHAIN_MODE=stub when the router is unreachable (auto mode)", async () => {
    const gm = process.env.GUARDIAN_MODE;
    delete process.env.GUARDIAN_MODE;
    process.env.ZG_MOCK = "0";
    process.env.ZG_API_KEY = "sk-team";
    try {
      expect(zgConnectMock()).toBe(false);
      router({ "GET /account/balance": "throw", "GET /models": "throw" });
      expect(await probeZg({ key: MK })).toMatchObject({ ok: true, kind: "mk", mock: true });
    } finally {
      delete process.env.ZG_MOCK;
      delete process.env.ZG_API_KEY;
      if (gm !== undefined) process.env.GUARDIAN_MODE = gm;
    }
  });
});

describe("billing rows", () => {
  it("fixture castles and arena units → team; keyed rows → their own key", () => {
    expect(billingFor({ id: "c1", zgApiKey: null })).toEqual({ kind: "team" });
    expect(billingFor({ id: "a1", zgApiKey: null, fundedBy: "arena" })).toEqual({ kind: "team" });
    expect(billingFor({ id: "c1", zgApiKey: "sk-1" })).toEqual({ kind: "user", userId: "castle:c1", apiKey: "sk-1" });
    expect(billingFor({ id: "a1", zgApiKey: "sk-2", fundedBy: "arena" })).toEqual({ kind: "user", userId: "agent:a1", apiKey: "sk-2" });
    expect(billingFor(null)).toEqual({ kind: "team" });
  });

  it("published guards, onboarding castles and operator units never fall back to the team key", () => {
    expect(needsUserBilling({ id: "c", zgApiKey: null, published: true })).toBe(true);
    expect(needsUserBilling({ id: "c", zgApiKey: null, ownerKeyHash: "h" })).toBe(true);
    expect(needsUserBilling({ id: "a", zgApiKey: null, fundedBy: "operator" })).toBe(true);
    expect(() => billingFor({ id: "c", zgApiKey: null, published: true })).toThrow(ZgNotConnectedError);
    expect(() => requireUserBilling({ id: "a", zgApiKey: " ", fundedBy: "operator" })).toThrow(/agent:a/);
  });
});
