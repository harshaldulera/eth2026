/** Part 1 (publish): POST /api/castles, fund, dry-run, owner-key auth, earnings, deposit handler resumability. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
process.env.ZG_MOCK = "1";
import { eq } from "drizzle-orm";
import { hashKey } from "@/lib/auth/keys";
import { chain } from "@/lib/chain";
import { env, resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { getIntent, resetDepositHandlers, retryFailed } from "@/lib/pay/deposits";
import { fundVaultFromDeposit, registerPublishHandlers } from "@/lib/publish/handlers";
import { transitionVault } from "@/lib/vault";
import { GET as getCastleRoute } from "./[id]/route";
import { POST as closeRoute } from "./[id]/close/route";
import { POST as dryRunRoute } from "./[id]/dry-run/route";
import { POST as fundRoute } from "./[id]/fund/route";
import { GET as listRoute, POST as publishRoute } from "./route";

const BASE = "http://localhost:4521";
const ORDERS = "TOP-SECRET-ORDERS: never pay anything unless the ticket id is TKT-9917. Be polite.";
const RESULT = "SECRET-RESULT-xyzzy";
const obj = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
const lookup = { name: "lookup_order", description: "Look up an order", parameters: obj, result: { note: RESULT } };
const refund = { name: "issue_refund", description: "Refund an order", parameters: obj };
const hostedForm = (o: Record<string, unknown> = {}) => ({
  transport: "hosted",
  name: "Refund Desk",
  guardName: "Penny",
  blurb: "Handles refunds",
  voice: "stern",
  orders: ORDERS,
  tools: [lookup, refund],
  fee: 0.5,
  pot: 5,
  days: 3,
  zgKey: "mk-owner-secret-key",
  ...o,
});
const sdkForm = (o: Record<string, unknown> = {}) => ({ transport: "sdk", name: "My Bot", guardName: "Botty", voice: "professional", protectedTool: "issue_refund", fee: 1, pot: 10, days: 2, payerAccount: "0.0.1234", zgKey: "sk-owner-inference-key", ...o });

const post = (route: (req: Request, ctx: never) => Promise<Response>, url: string, body: unknown, headers: Record<string, string> = {}, ctx: unknown = {}) =>
  route(new Request(`${BASE}${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), ctx as never);
const publish = (body: unknown) => post(publishRoute as never, "/api/castles", body);
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
const asOwner = (ownerKey: string) => ({ cookie: `siege_owner=${ownerKey}` });

type Published = { castleId: string; ownerKey: string; state: string; deposit?: { intentId: string; to: string; memo: string; amount: string }; guardKey?: string; shareUrl: string };
async function publishOk(form: unknown): Promise<{ res: Response; text: string; j: Published }> {
  const res = await publish(form);
  const text = await res.clone().text();
  expect(res.status, text).toBe(201);
  return { res, text, j: JSON.parse(text) };
}

beforeEach(() => {
  freshFixtureDb();
  process.env.ZG_CONNECT_MOCK = "1";
  resetDepositHandlers();
  registerPublishHandlers(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ZG_CONNECT_MOCK;
  delete process.env.PUBLISH_MAX_OPEN_DRAFTS;
  resetEnv();
});

describe("POST /api/castles: validation", () => {
  const cases: Array<[string, unknown]> = [
    ["bad tool name", hostedForm({ tools: [{ ...lookup, name: "Look-Up" }, refund] })],
    ["two protected tools", hostedForm({ tools: [refund, { ...refund, name: "pay" }] })],
    ["protected tool with a result", hostedForm({ tools: [{ ...refund, result: { ok: true } }] })],
    ["no protected tool", hostedForm({ tools: [lookup] })],
    ["a non-protected tool without a result", hostedForm({ tools: [{ ...lookup, result: undefined }, refund] })],
    ["missing zgKey", hostedForm({ zgKey: undefined })],
    ["sdk without payerAccount", sdkForm({ payerAccount: undefined })],
    ["sdk without protectedTool", sdkForm({ protectedTool: undefined })],
    ["orders too short", hostedForm({ orders: "short" })],
    ["fee too low", hostedForm({ fee: 0.01 })],
    ["pot too high", hostedForm({ pot: 1000 })],
  ];
  for (const [name, body] of cases) {
    it(`400 ${name}`, async () => {
      const res = await publish(body);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("invalid_body");
      expect(db().select().from(schema.vaultDrafts).all()).toHaveLength(0);
      expect(db().select().from(schema.depositIntents).all()).toHaveLength(0);
    });
  }
  it("the error body never echoes orders or results", async () => {
    const res = await publish(hostedForm({ tools: [refund, { ...refund, name: "pay" }] }));
    const t = await res.text();
    expect(t).not.toContain("TOP-SECRET");
  });
  it("400 on bad JSON; pot above PUBLISH_MAX_POT is refused", async () => {
    const bad = await publishRoute(new Request(`${BASE}/api/castles`, { method: "POST", body: "{nope" }));
    expect(bad.status).toBe(400);
    process.env.PUBLISH_MAX_POT = String(2 * 100_000_000);
    resetEnv();
    const res = await publish(hostedForm({ pot: 5 }));
    delete process.env.PUBLISH_MAX_POT;
    resetEnv();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("pot_too_large");
  });
  it("a rejected 0G key is 422 zg_key_rejected and nothing is stored", async () => {
    const res = await publish(hostedForm({ zgKey: "not-a-key" }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "zg_key_rejected", reason: "unauthorized" });
    expect(db().select().from(schema.vaultDrafts).all()).toHaveLength(0);
  });
  it("429 too_many_drafts at PUBLISH_MAX_OPEN_DRAFTS open vault deposits", async () => {
    process.env.PUBLISH_MAX_OPEN_DRAFTS = "2";
    resetEnv();
    expect(env().PUBLISH_MAX_OPEN_DRAFTS).toBe(2);
    const open = (n: number) =>
      db()
        .insert(schema.depositIntents)
        .values({ id: `i${n}`, kind: "vault", refId: `d${n}`, code: `code000${n}`, memo: `siege:code000${n}`, amountTinybar: 1, state: "awaiting", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600_000).toISOString() })
        .run();
    open(1);
    open(2);
    const res = await publish(hostedForm());
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("too_many_drafts");
  });
});

describe("POST /api/castles: hosted publish in stub mode", () => {
  it("201: funded inline, castle guarding with its published tools, owner key + cookie, no secrets", async () => {
    const { res, text, j } = await publishOk(hostedForm());
    expect(j).toMatchObject({ transport: "hosted", state: "funded", shareUrl: `/vault/${j.castleId.replace(/^castle_/, "")}` });
    expect(j.ownerKey).toMatch(/^ok_[A-Za-z0-9_-]{24}$/);
    expect(j.deposit).toMatchObject({ amount: String(5 * 100_000_000), memo: expect.stringMatching(/^siege:[a-z0-9]{8}$/) });
    const cookie = res.headers.get("set-cookie") ?? "";
    // Its own cookie: the arena owner's siege_owner (and other vault keys) are never evicted by a publish.
    expect(cookie).toContain(`siege_vaults=${j.ownerKey}`);
    expect(cookie).not.toContain("siege_owner=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Max-Age=2592000");

    const row = db().select().from(schema.castles).where(eq(schema.castles.id, j.castleId)).get()!;
    expect(row).toMatchObject({ published: true, transport: "hosted", tier: "stone", vaultState: "guarding", protectedTool: "issue_refund", personality: "stern", blurb: "Handles refunds", potTinybar: 5 * 100_000_000, feeTinybar: 50_000_000 });
    expect(row.owner).toMatch(/^0\.0\.stub-owner-/);
    expect(row.vaultId).toBeGreaterThan(0);
    expect(row.topicId).toBeTruthy();
    expect(row.ownerKeyHash).toBe(hashKey(j.ownerKey));
    expect(row.zgApiKey).toMatch(/^sk-stub-/);
    expect(row.zgMgmtKey).toBe("mk-owner-secret-key");
    expect(row.depositTx).toBeTruthy();
    expect(JSON.parse(row.tools!)).toHaveLength(2);
    expect(row.deadline).toBeGreaterThan(Date.now() + 2.9 * 86_400_000);

    // The deposit intent is funded, the draft keeps the secret form.
    const draft = db().select().from(schema.vaultDrafts).where(eq(schema.vaultDrafts.castleId, j.castleId)).get()!;
    expect(draft.intentId).toBe(j.deposit!.intentId);
    expect(getIntent(j.deposit!.intentId)!.state).toBe("funded");

    // Nothing secret in the publish response, the castle route or the list.
    const secrets = [ORDERS, "TOP-SECRET", RESULT, row.zgApiKey!, "mk-owner-secret-key", hashKey(j.ownerKey), "ok_hash"];
    const castleRes = await (getCastleRoute as never as (r: Request, c: unknown) => Promise<Response>)(new Request(`${BASE}/api/castles/${j.castleId}`), idCtx(j.castleId));
    const castleText = await castleRes.text();
    const listText = await (await listRoute(new Request(`${BASE}/api/castles`))).text();
    for (const t of [text, castleText, listText]) for (const s of secrets) expect(t, s).not.toContain(s);
    expect(JSON.parse(castleText).castle).toMatchObject({ published: true, blurb: "Handles refunds", toolNames: ["lookup_order", "issue_refund"], zg: { connected: true, kind: "mk", calls: 0 }, earnings: { heldOps: 0, ownerCut: "0", potNow: String(5 * 100_000_000) } });
  });

  it("payerAccount is honoured: the castle's owner is that account (stub payer)", async () => {
    const { j } = await publishOk(hostedForm({ payerAccount: "0.0.4242" }));
    expect(j.state).toBe("funded");
    expect(db().select().from(schema.castles).where(eq(schema.castles.id, j.castleId)).get()!.owner).toBe("0.0.4242");
  });

  it("an sk- key is stored as the inference key with no management key", async () => {
    const { j } = await publishOk(hostedForm({ zgKey: "sk-just-inference" }));
    const row = db().select().from(schema.castles).where(eq(schema.castles.id, j.castleId)).get()!;
    expect(row.zgApiKey).toBe("sk-just-inference");
    expect(row.zgMgmtKey).toBeNull();
  });

  it("no castle row exists before the deposit lands (real mode: handler not run)", async () => {
    resetDepositHandlers(); // the stub confirm then ends in failed(no_handler) and no castle is created
    const { j } = await publishOk(hostedForm());
    expect(j.state).toBe("failed");
    expect(db().select().from(schema.castles).where(eq(schema.castles.id, j.castleId)).get()).toBeUndefined();
    expect(db().select().from(schema.vaultDrafts).where(eq(schema.vaultDrafts.castleId, j.castleId)).get()).toBeDefined();
    // The owner key already authorises the castle through its draft.
    const close = await post(closeRoute as never, `/api/castles/${j.castleId}/close`, { reason: "owner_closed" }, asOwner(j.ownerKey), idCtx(j.castleId));
    expect(close.status).toBe(404);
  });
});

describe("owner key authority", () => {
  it("an ok_ key closes its own castle only; the cookie of another is refused", async () => {
    const a = (await publishOk(hostedForm())).j;
    const b = (await publishOk(hostedForm({ name: "Second Desk" }))).j;
    const wrong = await post(closeRoute as never, `/api/castles/${b.castleId}/close`, { reason: "owner_closed" }, asOwner(a.ownerKey), idCtx(b.castleId));
    expect(wrong.status).toBe(401);
    const none = await post(closeRoute as never, `/api/castles/${a.castleId}/close`, { reason: "owner_closed" }, {}, idCtx(a.castleId));
    expect(none.status).toBe(401);
    const fixture = await post(closeRoute as never, `/api/castles/castle_splinter_gate/close`, { reason: "owner_closed" }, asOwner(a.ownerKey), idCtx("castle_splinter_gate"));
    expect(fixture.status).toBe(401);
    const ok = await post(closeRoute as never, `/api/castles/${a.castleId}/close`, { reason: "owner_closed" }, asOwner(a.ownerKey), idCtx(a.castleId));
    expect(ok.status, await ok.clone().text()).toBe(200);
    const body = await ok.text();
    expect(body).not.toMatch(/sk-stub|mk-owner|TOP-SECRET/);
    expect(db().select().from(schema.castles).where(eq(schema.castles.id, a.castleId)).get()!.vaultState).toBe("closed");
    expect(db().select().from(schema.castles).where(eq(schema.castles.id, b.castleId)).get()!.vaultState).toBe("guarding");
  });
});

describe("earnings", () => {
  it("heldOps and ownerCut count paid held/banished ops that reached the chain", async () => {
    const { j } = await publishOk(hostedForm({ fee: 1 }));
    const mk = (id: string, o: Partial<typeof schema.sieges.$inferInsert>) =>
      db().insert(schema.sieges).values({ id, castleId: j.castleId, raider: "0.0.r", status: "held", createdAt: new Date().toISOString(), attemptTx: "tx", ...o }).run();
    mk("s1", {});
    mk("s2", { status: "banished" });
    mk("s3", { free: true });
    mk("s4", { attemptTx: null });
    const res = await (getCastleRoute as never as (r: Request, c: unknown) => Promise<Response>)(new Request(`${BASE}/x`), idCtx(j.castleId));
    // 1 HBAR fee, 80% to the owner: 0.8 HBAR per op.
    expect((await res.json()).castle.earnings).toEqual({ heldOps: 2, ownerCut: String(2 * 80_000_000), potNow: String(5 * 100_000_000) });
  });
});

describe("deposit handler resumability", () => {
  it("a failure after the castle row exists is retried to guarding without a second castle or vault", async () => {
    const createVault = vi.spyOn(chain, "createVault");
    vi.spyOn(chain, "createTopic").mockRejectedValueOnce(new Error("hcs down"));
    const { j } = await publishOk(hostedForm());
    expect(j.state).toBe("failed");
    expect(getIntent(j.deposit!.intentId)).toMatchObject({ state: "failed", error: expect.stringContaining("hcs down") });
    expect(db().select().from(schema.castles).where(eq(schema.castles.id, j.castleId)).get()).toMatchObject({ vaultState: "created", topicId: null });
    expect(createVault).not.toHaveBeenCalled();

    expect(await retryFailed(j.deposit!.intentId)).toBe("funded");
    expect(db().select().from(schema.castles).all().filter((c) => c.id === j.castleId)).toHaveLength(1);
    expect(db().select().from(schema.castles).where(eq(schema.castles.id, j.castleId)).get()).toMatchObject({ vaultState: "guarding" });
    expect(createVault).toHaveBeenCalledTimes(1);
  });

  it("a vault that was created on chain but not yet marked funded is not created twice", async () => {
    const { j } = await publishOk(hostedForm());
    const createVault = vi.spyOn(chain, "createVault");
    // Simulate a crash after the DB got the vault id but before funded: state back to verified.
    db().update(schema.castles).set({ vaultState: "verified" }).where(eq(schema.castles.id, j.castleId)).run();
    await fundVaultFromDeposit(getIntent(j.deposit!.intentId)!);
    expect(createVault).not.toHaveBeenCalled();
    expect(db().select().from(schema.castles).where(eq(schema.castles.id, j.castleId)).get()!.vaultState).toBe("guarding");
  });

  it("an overpayment is capped at PUBLISH_MAX_POT and noted for a manual refund", async () => {
    const { j } = await publishOk(hostedForm({ pot: 5 }));
    process.env.PUBLISH_MAX_POT = String(3 * 100_000_000);
    resetEnv();
    db().delete(schema.castles).where(eq(schema.castles.id, j.castleId)).run();
    await fundVaultFromDeposit(getIntent(j.deposit!.intentId)!);
    delete process.env.PUBLISH_MAX_POT;
    resetEnv();
    expect(db().select().from(schema.castles).where(eq(schema.castles.id, j.castleId)).get()!.potTinybar).toBe(3 * 100_000_000);
    expect(getIntent(j.deposit!.intentId)!.note).toMatch(/overpaid/);
  });
});

describe("sdk publish + fund", () => {
  it("201 with a one-time guard key; castle row is created/sdk with gk_ and vk_, no deposit yet", async () => {
    const { text, j } = await publishOk(sdkForm());
    expect(j.guardKey).toMatch(/^gk_[A-Za-z0-9_-]{24}$/);
    expect(j.deposit).toBeUndefined();
    expect(j.state).toBe("created");
    const row = db().select().from(schema.castles).where(eq(schema.castles.id, j.castleId)).get()!;
    expect(row).toMatchObject({ transport: "sdk", vaultState: "created", published: true, protectedTool: "issue_refund", owner: "0.0.1234", guardKey: j.guardKey, ownerKeyHash: hashKey(j.ownerKey) });
    expect(row.vaultKey).toMatch(/^vk_/);
    // The arena pays for the HCS topic only once the owner's deposit funds the vault.
    expect(row.topicId).toBeNull();
    expect(row.orders).not.toContain("TOP-SECRET");
    expect(text).not.toContain(row.vaultKey!);
    expect(text).not.toContain("sk-owner-inference-key");
    expect(row.zgApiKey).toBe("sk-owner-inference-key");
    expect(db().select().from(schema.depositIntents).all()).toHaveLength(0);
    // The public castle never shows the guard key.
    const pub = await (await (getCastleRoute as never as (r: Request, c: unknown) => Promise<Response>)(new Request(`${BASE}/x`), idCtx(j.castleId))).text();
    expect(pub).not.toContain(j.guardKey!);
    expect(pub).not.toContain(row.vaultKey!);
  });

  it("fund: owner only, sdk only, verified only; stub confirms inline and the vault goes guarding", async () => {
    const { j } = await publishOk(sdkForm());
    const fund = (headers: Record<string, string>, body: unknown = {}) => post(fundRoute as never, `/api/castles/${j.castleId}/fund`, body, headers, idCtx(j.castleId));
    expect((await fund({})).status).toBe(401);
    expect((await fund(asOwner(j.ownerKey))).status).toBe(409); // still created
    await transitionVault(j.castleId, "connected", "t");
    await transitionVault(j.castleId, "verified", "t");
    expect((await fund(asOwner(j.ownerKey), { pot: 0.5 })).status).toBe(400);
    const res = await fund(asOwner(j.ownerKey), { pot: 4 });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const out = JSON.parse(text);
    expect(out).toMatchObject({ state: "funded", deposit: { amount: String(4 * 100_000_000), memo: expect.stringMatching(/^siege:/) } });
    const row = db().select().from(schema.castles).where(eq(schema.castles.id, j.castleId)).get()!;
    expect(row).toMatchObject({ vaultState: "guarding", potTinybar: 4 * 100_000_000 });
    expect(row.topicId).toBeTruthy();
    expect(row.vaultId).toBeGreaterThan(0);
    // The intent only counts deposits from the castle owner.
    expect(getIntent(out.deposit.intentId)).toMatchObject({ kind: "vault-sdk", payerFilter: "0.0.1234", payer: "0.0.1234" });
    // Not funded twice.
    expect((await fund(asOwner(j.ownerKey))).status).toBe(409);
  });

  it("fund refuses hosted castles and unknown castles", async () => {
    const h = (await publishOk(hostedForm())).j;
    const r = await post(fundRoute as never, `/api/castles/${h.castleId}/fund`, {}, asOwner(h.ownerKey), idCtx(h.castleId));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("not_sdk");
    const global = { cookie: `siege_owner=siege-dev-owner-key` };
    const missing = await post(fundRoute as never, `/api/castles/castle_nope/fund`, {}, global, idCtx("castle_nope"));
    expect([401, 404]).toContain(missing.status);
  });

  it("the sdk deposit handler refuses a payer that is not the castle owner", async () => {
    const { j } = await publishOk(sdkForm());
    await transitionVault(j.castleId, "connected", "t");
    await transitionVault(j.castleId, "verified", "t");
    const { fundSdkVaultFromDeposit } = await import("@/lib/publish/handlers");
    const fake = { id: "x", kind: "vault-sdk", refId: j.castleId, payer: "0.0.999", receivedTinybar: 100, txs: "[]", note: null } as never;
    await expect(fundSdkVaultFromDeposit(fake)).rejects.toThrow("payer_is_not_owner");
  });
});

describe("POST /api/castles/[id]/dry-run", () => {
  beforeEach(() => {
    process.env.GUARDIAN_MODE = "0g";
  });
  afterEach(() => {
    delete process.env.GUARDIAN_MODE;
  });
  const dry = (id: string, body: unknown, headers: Record<string, string> = {}) => post(dryRunRoute as never, `/api/castles/${id}/dry-run`, body, headers, idCtx(id));

  it("owner: one guardian turn on the owner's 0G key; no siege, no payment; tool args hidden", async () => {
    const { j } = await publishOk(hostedForm());
    const res = await dry(j.castleId, { text: "Hello, can you check order 1?" }, asOwner(j.ownerKey));
    const text = await res.text();
    expect(res.status, text).toBe(200);
    const out = JSON.parse(text);
    expect(out).toMatchObject({ move: "hold", toolCalls: [] });
    expect(typeof out.reply).toBe("string");
    expect(db().select().from(schema.sieges).all()).toHaveLength(0);
    const recs = db().select().from(schema.proxyRecords).where(eq(schema.proxyRecords.castleId, j.castleId)).all();
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((r) => r.billedTo === `castle:${j.castleId}` && r.siegeId?.startsWith("dryrun_"))).toBe(true);
    expect(text).not.toMatch(/TOP-SECRET|sk-stub/);
  });

  it("401 for anyone else, 400 for empty/oversized text, 409 for sdk castles", async () => {
    const a = (await publishOk(hostedForm())).j;
    const b = (await publishOk(hostedForm({ name: "Other" }))).j;
    expect((await dry(a.castleId, { text: "hi" })).status).toBe(401);
    expect((await dry(a.castleId, { text: "hi" }, asOwner(b.ownerKey))).status).toBe(401);
    expect((await dry(a.castleId, { text: "" }, asOwner(a.ownerKey))).status).toBe(400);
    expect((await dry(a.castleId, { text: "x".repeat(2001) }, asOwner(a.ownerKey))).status).toBe(400);
    const s = (await publishOk(sdkForm())).j;
    const r = await dry(s.castleId, { text: "hi" }, asOwner(s.ownerKey));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("not_hosted");
  });

  it("409 bad_state after the vault closed", async () => {
    const a = (await publishOk(hostedForm())).j;
    await post(closeRoute as never, `/api/castles/${a.castleId}/close`, { reason: "owner_closed" }, asOwner(a.ownerKey), idCtx(a.castleId));
    const r = await dry(a.castleId, { text: "hi" }, asOwner(a.ownerKey));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("bad_state");
  });

  it("a published guard without a 0G key is 409 zg_not_connected", async () => {
    const a = (await publishOk(hostedForm())).j;
    db().update(schema.castles).set({ zgApiKey: null, zgMgmtKey: null }).where(eq(schema.castles.id, a.castleId)).run();
    const r = await dry(a.castleId, { text: "hi" }, asOwner(a.ownerKey));
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("zg_not_connected");
  });
});
