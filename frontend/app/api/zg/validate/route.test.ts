/** POST /api/zg/validate: probe only, never echoes or stores the key. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { POST } from "./route";

const BASE = "http://localhost:4512";
let ip = 0;
const validate = (body: unknown, client = `10.0.0.${++ip}`) =>
  POST(new Request(`${BASE}/api/zg/validate`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": client }, body: JSON.stringify(body) }));

beforeEach(() => freshFixtureDb());
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ZG_CONNECT_MOCK;
});

describe("POST /api/zg/validate", () => {
  it("stub: mk- → kind, balance, models; the key is never in the response", async () => {
    const res = await validate({ key: "mk-secret-management" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("mk-secret-management");
    const j = JSON.parse(text);
    expect(j).toMatchObject({ ok: true, kind: "mk", mock: true });
    expect(Number(j.balance)).toBeGreaterThan(0);
    expect(j.models.length).toBeGreaterThan(0);
  });

  it("stub: sk- → no balance", async () => {
    const j = await (await validate({ key: "sk-inference" })).json();
    expect(j).toMatchObject({ ok: true, kind: "sk" });
    expect(j.balance).toBeUndefined();
  });

  it("a bad key → 200 { ok: false, reason }", async () => {
    expect(await (await validate({ key: "hello" })).json()).toEqual({ ok: false, reason: "unauthorized" });
  });

  it("real router: 403 on the balance → needs_account_read; never mints", async () => {
    process.env.ZG_CONNECT_MOCK = "0";
    const methods: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_u, init) => {
      methods.push(init?.method ?? "GET");
      return new Response(JSON.stringify({ error: { code: "insufficient_scope" } }), { status: 403 });
    });
    expect(await (await validate({ key: "mk-x" })).json()).toEqual({ ok: false, reason: "needs_account_read" });
    expect(methods.every((m) => m === "GET")).toBe(true);
  });

  it("stores nothing", async () => {
    await validate({ key: "mk-store-test" });
    const rows = db().select({ k: schema.castles.zgApiKey, m: schema.castles.zgMgmtKey }).from(schema.castles).all();
    expect(rows.every((r) => r.k === null && r.m === null)).toBe(true);
  });

  it("400 on a missing key, 429 past 20 checks a minute from one client", async () => {
    expect((await validate({})).status).toBe(400);
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await validate({ key: "sk-a" }, "10.9.9.9")).status;
    expect(last).toBe(429);
  });
});
