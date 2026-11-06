/**
 * Onboarding review fix round (money safety): /open and vault-state can't spend the arena's money for an
 * ok_ key outside stub mode; fundVault is claimed atomically; ok_ keys live in their own cookie; the SDK
 * publish path is capped and pays no topic before a deposit; repeated FUND reuses its window; a deposit
 * with nothing left to fund is noted; guard-key rotation also kills the old vk_.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
process.env.ZG_MOCK = "1";

const flags = vi.hoisted(() => ({ stub: true }));
vi.mock("@/lib/config/env", async (orig) => {
  const m = await orig<typeof import("@/lib/config/env")>();
  return { ...m, isStub: () => flags.stub && m.isStub() };
});

import { eq } from "drizzle-orm";
import { hashKey } from "@/lib/auth/keys";
import { chain } from "@/lib/chain";
import { resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { rotateGuardKey } from "@/lib/guard/keys";
import { createIntent, getIntent, resetDepositHandlers } from "@/lib/pay/deposits";
import { registerPublishHandlers } from "@/lib/publish/handlers";
import { issueKey, vaultForKey } from "@/lib/proxy";
import { fundVault, transitionVault } from "@/lib/vault";
import { isOwnerOf, VAULTS_COOKIE } from "../_lib/http";
import { POST as ownerRoute } from "../owner/route";
import { POST as fundRoute } from "./[id]/fund/route";
import { POST as openRoute } from "./[id]/open/route";
import { POST as vaultStateRoute } from "./[id]/vault-state/route";
import { POST as publishRoute } from "./route";

const BASE = "http://localhost:4900";
const sdkForm = (o: Record<string, unknown> = {}) => ({
  transport: "sdk",
  name: "My Bot",
  guardName: "Botty",
  voice: "professional",
  protectedTool: "issue_refund",
  fee: 1,
  pot: 100,
  days: 2,
  payerAccount: "0.0.6666",
  zgKey: "sk-owner-inference-key",
  ...o,
});
const post = (route: (req: Request, ctx: never) => Promise<Response>, url: string, body: unknown, headers: Record<string, string> = {}, ctx: unknown = {}) =>
  route(new Request(`${BASE}${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), ctx as never);
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const ownerKeyHeader = (k: string) => ({ "x-siege-owner-key": k });
const GLOBAL = { cookie: "siege_owner=siege-demo-owner" };

async function publishSdk(o: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await post(publishRoute as never, "/api/castles", sdkForm(o), headers);
  const text = await res.text();
  expect(res.status, text).toBe(201);
  return { res, j: JSON.parse(text) as { castleId: string; ownerKey: string; guardKey: string } };
}
async function verified(castleId: string) {
  await transitionVault(castleId, "connected", "t");
  await transitionVault(castleId, "verified", "t");
}

beforeEach(() => {
  flags.stub = true;
  freshFixtureDb();
  process.env.ZG_CONNECT_MOCK = "1";
  resetDepositHandlers();
  registerPublishHandlers(true);
});
afterEach(() => {
  flags.stub = true;
  vi.restoreAllMocks();
  delete process.env.ZG_CONNECT_MOCK;
  delete process.env.PUBLISH_MAX_OPEN_DRAFTS;
  resetEnv();
});

describe("POST /open and vault-state funded: never the arena's money for an ok_ key (outside stub)", () => {
  it("testnet-like: an SDK publisher's ok_ key gets 409 fund_by_deposit and no vault is created", async () => {
    const { j } = await publishSdk();
    await verified(j.castleId);
    const create = vi.spyOn(chain, "createVault");
    flags.stub = false;
    const open = await post(openRoute as never, `/api/castles/${j.castleId}/open`, {}, ownerKeyHeader(j.ownerKey), idCtx(j.castleId));
    expect(open.status).toBe(409);
    expect((await open.json()).error).toBe("fund_by_deposit");
    // The dev endpoint on a deployment with SIEGE_DEV_ENDPOINTS=1 is the same door: closed too.
    process.env.SIEGE_DEV_ENDPOINTS = "1";
    try {
      const vs = await post(vaultStateRoute as never, `/api/castles/${j.castleId}/vault-state`, { to: "funded" }, ownerKeyHeader(j.ownerKey), idCtx(j.castleId));
      expect(vs.status).toBe(409);
      expect((await vs.json()).error).toBe("fund_by_deposit");
    } finally {
      delete process.env.SIEGE_DEV_ENDPOINTS;
    }
    expect(create).not.toHaveBeenCalled();
    expect(db().select().from(schema.castles).where(eq(schema.castles.id, j.castleId)).get()?.vaultState).toBe("verified");
    // Stub (fake money): the castle's own key may still open it (plan: "funded … or /open in stub").
    flags.stub = true;
    const stubOpen = await post(openRoute as never, `/api/castles/${j.castleId}/open`, {}, ownerKeyHeader(j.ownerKey), idCtx(j.castleId));
    expect(stubOpen.status).toBe(200);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("an unknown caller is 401; the global owner may still open (stub)", async () => {
    const { j } = await publishSdk();
    await verified(j.castleId);
    expect((await post(openRoute as never, `/api/castles/${j.castleId}/open`, {}, {}, idCtx(j.castleId))).status).toBe(401);
    const ok = await post(openRoute as never, `/api/castles/${j.castleId}/open`, {}, GLOBAL, idCtx(j.castleId));
    expect(ok.status).toBe(200);
  });

  it("fundVault is claimed once: two concurrent callers create ONE vault", async () => {
    const { j } = await publishSdk();
    await verified(j.castleId);
    const real = chain.createVault;
    const create = vi.spyOn(chain, "createVault").mockImplementation(async (i) => {
      await new Promise((r) => setTimeout(r, 30));
      return real(i);
    });
    const [a, b] = await Promise.all([fundVault(j.castleId), fundVault(j.castleId)]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((r) => !r.ok)).toMatchObject({ reason: "fund_in_progress" });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a clean createVault failure releases the claim so the next try can fund", async () => {
    const { j } = await publishSdk();
    await verified(j.castleId);
    vi.spyOn(chain, "createVault").mockResolvedValueOnce({ ok: false, reason: "InsufficientPot" } as never);
    expect(await fundVault(j.castleId)).toMatchObject({ ok: false, reason: "InsufficientPot" });
    expect((await fundVault(j.castleId)).ok).toBe(true);
  });

  it("an in-doubt createVault (receipt timeout) keeps the claim: no automatic second vault", async () => {
    const { j } = await publishSdk();
    await verified(j.castleId);
    vi.spyOn(chain, "createVault").mockResolvedValueOnce({ ok: false, reason: "receipt_timeout" } as never);
    expect((await fundVault(j.castleId)).ok).toBe(false);
    expect(await fundVault(j.castleId)).toMatchObject({ ok: false, reason: "fund_in_progress" });
  });
});

describe("castle owner keys live in siege_vaults, never in siege_owner", () => {
  it("publishing twice in one browser keeps both vault keys and the arena owner's cookie", async () => {
    const first = await publishSdk();
    const c1 = first.res.headers.get("set-cookie")!;
    expect(c1).toMatch(new RegExp(`^${VAULTS_COOKIE}=`));
    const held = decodeURIComponent(c1.split(";")[0]!.split("=")[1]!);
    const second = await publishSdk({ name: "Second" }, { cookie: `siege_owner=siege-demo-owner; ${VAULTS_COOKIE}=${encodeURIComponent(held)}` });
    const c2 = decodeURIComponent(second.res.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!);
    expect(c2.split(",")).toEqual([second.j.ownerKey, first.j.ownerKey]);
    const req = new Request(BASE, { headers: { cookie: `siege_owner=siege-demo-owner; ${VAULTS_COOKIE}=${encodeURIComponent(c2)}` } });
    expect(isOwnerOf(req, first.j.castleId) && isOwnerOf(req, second.j.castleId)).toBe(true);
    const onlyVaults = new Request(BASE, { headers: { cookie: `${VAULTS_COOKIE}=${encodeURIComponent(c2)}` } });
    expect(isOwnerOf(onlyVaults, first.j.castleId)).toBe(true);
    expect(isOwnerOf(onlyVaults, "castle_granite_hold")).toBe(false);
  });

  it("POST /api/owner with an ok_ key adds it to siege_vaults; the global secret still sets siege_owner", async () => {
    const { j } = await publishSdk();
    const r = await post(ownerRoute as never, "/api/owner", { key: j.ownerKey }, { cookie: `${VAULTS_COOKIE}=ok_${"a".repeat(24)}` });
    expect(r.status).toBe(200);
    const sc = r.headers.get("set-cookie")!;
    expect(sc).toMatch(new RegExp(`^${VAULTS_COOKIE}=`));
    expect(decodeURIComponent(sc.split(";")[0]!.split("=")[1]!).split(",")).toEqual([j.ownerKey, `ok_${"a".repeat(24)}`]);
    const g = await post(ownerRoute as never, "/api/owner", { key: "siege-demo-owner" });
    expect(g.headers.get("set-cookie")).toMatch(/^siege_owner=/);
  });
});

describe("SDK publish: capped, and no arena-paid topic before the deposit", () => {
  it("429 too_many_drafts once PUBLISH_MAX_OPEN_DRAFTS unfunded sdk vaults exist", async () => {
    process.env.PUBLISH_MAX_OPEN_DRAFTS = "2";
    resetEnv();
    const topic = vi.spyOn(chain, "createTopic");
    await publishSdk();
    await publishSdk({ name: "Two" });
    const third = await post(publishRoute as never, "/api/castles", sdkForm({ name: "Three" }));
    expect(third.status).toBe(429);
    expect((await third.json()).error).toBe("too_many_drafts");
    expect(topic).not.toHaveBeenCalled();
  });
});

describe("FUND twice / deposits with nothing left to fund", () => {
  it("a second FUND returns the window that is still open; a deposit for a guarding vault is noted, not used", async () => {
    // Testnet-like intents (no inline confirm) via a delay, so the first window stays open.
    process.env.SIEGE_STUB_DEPOSIT_DELAY_MS = "60000";
    resetEnv();
    try {
      const { j } = await publishSdk({ pot: 4 });
      await verified(j.castleId);
      const f1 = await (await post(fundRoute as never, `/api/castles/${j.castleId}/fund`, {}, ownerKeyHeader(j.ownerKey), idCtx(j.castleId))).json();
      const f2 = await (await post(fundRoute as never, `/api/castles/${j.castleId}/fund`, {}, ownerKeyHeader(j.ownerKey), idCtx(j.castleId))).json();
      expect(f2.deposit.intentId).toBe(f1.deposit.intentId);
      expect(f2.deposit.memo).toBe(f1.deposit.memo);
    } finally {
      delete process.env.SIEGE_STUB_DEPOSIT_DELAY_MS;
      resetEnv();
    }
  });

  it("vault-sdk deposit landing on a guarding vault: funded with a refund note, no second vault", async () => {
    const { j } = await publishSdk({ pot: 4 });
    await verified(j.castleId);
    const first = await createIntent({ kind: "vault-sdk", refId: j.castleId, amountTinybar: 400_000_000, payerFilter: "0.0.6666" });
    expect(first.state).toBe("funded");
    const create = vi.spyOn(chain, "createVault");
    const again = await createIntent({ kind: "vault-sdk", refId: j.castleId, amountTinybar: 400_000_000, payerFilter: "0.0.6666" });
    expect(again.state).toBe("funded");
    expect(getIntent(again.intentId)?.note).toMatch(/not_fundable: vault is guarding, refund manually/);
    expect(create).not.toHaveBeenCalled();
  });

  it("the deposit status reports SETTING UP progress (k/n) for a vault", async () => {
    const { j } = await publishSdk({ pot: 4 });
    await verified(j.castleId);
    const i = await createIntent({ kind: "vault-sdk", refId: j.castleId, amountTinybar: 400_000_000, payerFilter: "0.0.6666" });
    expect(getIntent(i.intentId)?.step).toBe("3/3 guard live");
  });
});

describe("guard key rotation also rotates the vault (proxy) key", () => {
  it("the old vk_ is refused at once, even when this process had it cached", async () => {
    const { j } = await publishSdk();
    const row = db().select().from(schema.castles).where(eq(schema.castles.id, j.castleId)).get()!;
    const oldVk = row.vaultKey!;
    expect(issueKey(j.castleId, row.protectedTool)).toBe(oldVk);
    expect(vaultForKey(oldVk)?.castleId).toBe(j.castleId);
    expect(rotateGuardKey(j.castleId)).toMatch(/^gk_/);
    const after = db().select().from(schema.castles).where(eq(schema.castles.id, j.castleId)).get()!;
    expect(after.vaultKey).toMatch(/^vk_/);
    expect(after.vaultKey).not.toBe(oldVk);
    expect(vaultForKey(oldVk)).toBeUndefined();
    expect(vaultForKey(after.vaultKey!)?.castleId).toBe(j.castleId);
    expect(after.ownerKeyHash).toBe(hashKey(j.ownerKey));
  });
});
