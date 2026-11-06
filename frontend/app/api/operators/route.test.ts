/** Operator handles: POST /api/operators (rk_ keyed), GET /api/operators/[account], and the Hall's names. */
import { beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { hashKey, newKey } from "@/lib/auth/keys";
import { resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { WOODEN_BREAK } from "@/lib/fixtures/raids";
import { GET as statsGet } from "@/app/api/stats/route";
import { runOp, settle } from "@/app/api/stats/ops.test-util";
import { GET as getHandle } from "./[account]/route";
import { POST } from "./route";

const BASE = "http://localhost:4543";

function unit(id: string, ownerId: string): string {
  const key = newKey("rk");
  db()
    .insert(schema.raiderAgents)
    .values({
      id,
      name: id,
      ownerId,
      strategy: "authority",
      accountId: `0.0.stub-${id}`,
      budgetTinybar: 1e9,
      perCastleCapTinybar: 1e8,
      dailyCapTinybar: 1e9,
      status: "idle",
      createdAt: new Date().toISOString(),
      operatorKeyHash: hashKey(key),
      fundedBy: "operator",
    })
    .run();
  return key;
}

const claim = (handle: unknown, headers: Record<string, string> = {}) =>
  POST(new Request(`${BASE}/api/operators`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ handle }) }));
const asKey = (k: string) => ({ "x-siege-operator-key": k });
const lookup = (account: string) => getHandle(new Request(`${BASE}/api/operators/${account}`), { params: Promise.resolve({ account }) });

beforeEach(() => {
  process.env.CHAIN_MODE = "stub";
  freshFixtureDb();
  resetEnv();
});

describe("POST /api/operators", () => {
  it("sets the handle for the unit's owner account; GET is public and lower-cases", async () => {
    const rk = unit("u1", "0.0.4001");
    const res = await claim("Night-Owl", asKey(rk));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, account: "0.0.4001", handle: "night-owl" });
    const got = await lookup("0.0.4001");
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ account: "0.0.4001", handle: "night-owl" });
    expect(JSON.stringify(await (await lookup("0.0.4001")).json())).not.toContain("rk_");
  });

  it("accepts the key as a Bearer token and lets the same account change its handle", async () => {
    const rk = unit("u1", "0.0.4001");
    expect((await claim("first", { authorization: `Bearer ${rk}` })).status).toBe(200);
    expect((await claim("second", asKey(rk))).status).toBe(200);
    expect(db().select().from(schema.operators).all()).toHaveLength(1);
    expect((await (await lookup("0.0.4001")).json()).handle).toBe("second");
  });

  it("409 handle_taken for another account, case-insensitively; re-claiming your own is fine", async () => {
    const a = unit("u1", "0.0.4001");
    const b = unit("u2", "0.0.4002");
    expect((await claim("taken-name", asKey(a))).status).toBe(200);
    const res = await claim("TAKEN-NAME", asKey(b));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("handle_taken");
    expect((await claim("taken-name", asKey(a))).status).toBe(200);
  });

  it("401 without a valid operator key (none, unknown, or a non-rk key)", async () => {
    unit("u1", "0.0.4001");
    for (const h of [{}, asKey(newKey("rk")), asKey(newKey("ok"))]) {
      const res = await claim("whoever", h);
      expect(res.status).toBe(401);
      expect((await res.json()).error).toBe("operator_key_required");
    }
    expect(db().select().from(schema.operators).all()).toHaveLength(0);
  });

  it("400 for handles outside /^[a-z0-9_-]{3,20}$/i", async () => {
    const rk = unit("u1", "0.0.4001");
    for (const h of ["ab", "x".repeat(21), "has space", "emoji-😀", "dot.name", ""]) {
      const res = await claim(h, asKey(rk));
      expect(res.status, h).toBe(400);
    }
    expect((await claim(7 as never, asKey(rk))).status).toBe(400);
  });

  it("409 unit_has_no_account for an arena-owned unit", async () => {
    const rk = unit("seed", "owner");
    const res = await claim("arena-unit", asKey(rk));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("unit_has_no_account");
  });

  it("GET 404 for an account with no handle", async () => {
    expect((await lookup("0.0.999")).status).toBe(404);
  });
});

describe("the Hall shows handles", () => {
  it("opName prefers the handle of the paying account over the shortened id", async () => {
    const siege = await runOp("castle_splinter_gate", WOODEN_BREAK, { raider: "0.0.stub-handled-raider-account-1" });
    settle(siege);
    const before = ((await (await statsGet()).json()) as { boards: { operators: { account: string; name: string }[] } }).boards.operators.find((o) => o.account.startsWith("0.0.stub-handled"))!;
    expect(before.name).not.toBe("hall-hero");
    const rk = unit("u9", "0.0.stub-handled-raider-account-1");
    expect((await claim("hall-hero", asKey(rk))).status).toBe(200);
    const after = ((await (await statsGet()).json()) as { boards: { operators: { account: string; name: string }[] } }).boards.operators.find((o) => o.account.startsWith("0.0.stub-handled"))!;
    expect(after.name).toBe("hall-hero");
  });
});
