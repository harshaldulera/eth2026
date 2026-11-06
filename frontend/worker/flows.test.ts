/**
 * Stub-mode flows through the real route handlers + worker passes: castle-closed windows (no fee is
 * taken for, and no siege can keep playing on, a castle that was already won), void + refund,
 * owner-only agent routes, approvals vs. stop, free sieges vs. streak, the events tail, seed re-arm.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { eq } from "drizzle-orm";
import { DEFAULT_OWNER_SECRET, env, resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { MUST_NOT_BREAK, WOODEN_BREAK } from "@/lib/fixtures/raids";
import { castleClosedReason } from "@/lib/castles";
import { emit } from "@/lib/events/bus";
import { createAgent, getAgent } from "@/lib/agents/accounts";
import { decideApproval, requestApproval, STUB_PAYMENT_HEADER } from "@/lib/pay";
import { getSiege } from "@/lib/siege";
import { renderLine } from "@/lib/guardian/stub";
import type { Siege } from "@/lib/types";
import { createInProcessFetch } from "./dispatch";
import { setFetch } from "./fetch";
import { settleTick } from "./settle";
import { agentsTick } from "./agents";
import { setWorkerQuiet } from "./log";
import { startRun } from "@/app/api/_lib/runs";

setWorkerQuiet(true);
const BASE = "http://localhost:3000";
const f = createInProcessFetch(BASE);
const WOOD = "castle_splinter_gate";

async function call<T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await f(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: (await res.json().catch(() => null)) as T };
}

const pay = (raider = "0.0.stub-raider") => ({ [STUB_PAYMENT_HEADER]: raider });

async function paidSiege(castleId: string, raider?: string): Promise<string> {
  const r = await call<{ siegeId: string }>("POST", "/api/siege/start", { castleId }, pay(raider));
  expect(r.status).toBe(200);
  return r.data.siegeId;
}

async function say(siegeId: string, text: string) {
  return call<{ siege: Siege; error?: string }>("POST", `/api/siege/${siegeId}/message`, { text });
}

async function ownerCookie(): Promise<Record<string, string>> {
  const res = await f(`${BASE}/api/owner`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: env().OWNER_SECRET }) });
  return { cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
}

const receiptOf = (siegeId: string) => {
  const s = db().select().from(schema.sieges).where(eq(schema.sieges.id, siegeId)).get()!;
  return db().select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.id, s.receiptId!)).get()!;
};

beforeEach(() => {
  process.env.CHAIN_MODE = "stub";
  delete process.env.OWNER_SECRET;
  freshFixtureDb();
  resetEnv();
  setFetch(f);
});

afterAll(() => setFetch(null));

describe("a castle that was already won takes no more fees and plays no more turns", () => {
  it("broken-but-unsettled castle: new paid siege -> 409 before any 402; in-progress siege -> 409 castle_closed; then void + refund", async () => {
    const a = await paidSiege(WOOD, "0.0.stub-a");
    const b = await paidSiege(WOOD, "0.0.stub-b");
    for (const t of WOODEN_BREAK) await say(a, t);
    expect(getSiege(a)!.status).toBe("broken");
    expect(castleClosedReason(WOOD)).toBe("being_broken");

    const late = await call<{ error: string; status: string }>("POST", "/api/siege/start", { castleId: WOOD }, pay("0.0.stub-c"));
    expect(late.status).toBe(409);
    expect(late.data).toMatchObject({ error: "castle_not_open", status: "broken" });
    const unpaid = await call("POST", "/api/siege/start", { castleId: WOOD });
    expect(unpaid.status).toBe(409); // not a 402: nobody is asked to pay for a won castle

    const bMsg = await say(b, WOODEN_BREAK[0]);
    expect(bMsg.status).toBe(409);
    expect(bMsg.data.error).toBe("castle_closed");

    await settleTick();
    const sa = getSiege(a)!;
    expect(sa.release?.amount).toBe("550000000");
    const sb = getSiege(b)!;
    expect(sb.settlement).toMatchObject({ state: "void", reason: "castle_broken", refund: { state: "refunded", amount: "50000000" } });
    expect(sb.settlement?.refund?.tx?.txId).toMatch(/^stub:refund@/);
    expect(receiptOf(b).state).toBe("refunded");
    // void sieges are not "live"
    const { listSieges } = await import("@/lib/siege");
    expect(listSieges({ status: "in_progress" }).map((s) => s.id)).not.toContain(b);
  });

  it("two raiders reach open_vault at the same moment: only one wins, the other is void and refunded", async () => {
    const a = await paidSiege(WOOD, "0.0.stub-a");
    const b = await paidSiege(WOOD, "0.0.stub-b");
    for (const t of WOODEN_BREAK.slice(0, 2)) {
      await say(a, t);
      await say(b, t);
    }
    const [ra, rb] = await Promise.all([say(a, WOODEN_BREAK[2]), say(b, WOODEN_BREAK[2])]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    const rows = [a, b].map((id) => db().select().from(schema.sieges).where(eq(schema.sieges.id, id)).get()!);
    expect(rows.map((r) => r.status)).toEqual(["broken", "broken"]);
    expect(rows.filter((r) => r.voidReason === "castle_already_broken")).toHaveLength(1);

    await settleTick();
    const winner = rows.find((r) => !r.voidReason)!.id;
    const loser = rows.find((r) => r.voidReason)!.id;
    expect(getSiege(winner)!.release).toBeTruthy();
    expect(getSiege(loser)!.release).toBeUndefined();
    expect(getSiege(loser)!.settlement).toMatchObject({ state: "void", refund: { state: "refunded" } });
  });

  it("a failed settlement is visible on the siege (the room stops waiting)", async () => {
    const id = await paidSiege(WOOD);
    for (const t of WOODEN_BREAK) await say(id, t);
    db().update(schema.sieges).set({ chainAttempts: 5, chainError: "bad_signature" }).where(eq(schema.sieges.id, id)).run();
    expect(getSiege(id)!.settlement).toEqual({ state: "failed", reason: "bad_signature" });
    expect(castleClosedReason(WOOD)).toBeNull(); // the vault is still open on chain
  });

  it("seed --rearm reopens a broken castle with a new vault and the fixture pot", async () => {
    const { seed } = await import("@/scripts/seed");
    await seed({ quiet: true });
    const id = await paidSiege(WOOD);
    for (const t of WOODEN_BREAK) await say(id, t);
    await settleTick();
    const before = db().select().from(schema.castles).where(eq(schema.castles.id, WOOD)).get()!;
    expect(before).toMatchObject({ status: "broken", potTinybar: 0 });
    await seed({ quiet: true, rearm: "wooden" });
    const after = db().select().from(schema.castles).where(eq(schema.castles.id, WOOD)).get()!;
    expect(after).toMatchObject({ status: "open", potTinybar: 500_000_000, vaultAddress: "stub" });
    expect(after.vaultId).not.toBe(before.vaultId);
    expect(castleClosedReason(WOOD)).toBeNull();
    // the re-armed vault really plays again: a held siege settles (the old release does not block it)
    const next = await paidSiege(WOOD);
    for (const t of MUST_NOT_BREAK) await say(next, t);
    await settleTick();
    expect(getSiege(next)!.attempt).toBeTruthy();
    const others = db().select().from(schema.castles).all().filter((c) => c.id !== WOOD);
    expect(others.every((c) => c.status === "open")).toBe(true);
  });
});

describe("vault lifecycle through the routes and the worker", () => {
  const DESK = "castle_refund_desk";
  async function addDesk(state: "created" | "guarding" = "created") {
    const { sdkFixtureCastleRow } = await import("@/lib/fixtures/castles");
    db().insert(schema.castles).values({ ...sdkFixtureCastleRow({ vaultState: state }), ...(state === "guarding" ? { vaultId: 7777, vaultAddress: "stub" } : {}) }).run();
  }
  const castleRow = (id: string) => db().select().from(schema.castles).where(eq(schema.castles.id, id)).get()!;
  const receipts = () => db().select().from(schema.paymentReceipts).all().length;

  it("a castle that is not guarding: 409 not_guarding before any 402 / payment / free claim, on both start routes", async () => {
    await addDesk("created");
    const before = receipts();
    const unpaid = await call<{ error: string; vaultState: string }>("POST", "/api/siege/start", { castleId: DESK });
    expect(unpaid.status).toBe(409);
    expect(unpaid.data).toMatchObject({ error: "not_guarding", vaultState: "created" });
    expect((await call("POST", "/api/siege/start", { castleId: DESK }, pay())).status).toBe(409);
    const free = await call<{ error: string }>("POST", "/api/siege/start", { castleId: DESK, free: true, wallet: "w-free" });
    expect(free.data.error).toBe("not_guarding");
    const play = await call<{ error: string }>("POST", "/api/play/start", { castleId: DESK });
    expect(play.status).toBe(409);
    expect(play.data.error).toBe("not_guarding");
    expect(receipts()).toBe(before);
    // the free siege was not used up
    const all = await call<{ castles: { id: string }[] }>("GET", "/api/castles");
    expect(all.data.castles.map((c) => c.id)).toContain(DESK);
    const board = await call<{ castles: { id: string }[] }>("GET", "/api/castles?vaultState=guarding");
    expect(board.data.castles.map((c) => c.id)).not.toContain(DESK);
    expect(board.data.castles).toHaveLength(5);
  });

  it("dev vault-state endpoint: owner only, legal transitions only, funded creates the vault; dormant refunds the in-flight fee", async () => {
    await addDesk("created");
    const owner = await ownerCookie();
    const vs = (to: string, headers = owner) => call<{ ok?: boolean; error?: string; vaultId?: number }>("POST", `/api/castles/${DESK}/vault-state`, { to, reason: `test ${to}` }, headers);
    expect((await vs("connected", {})).status).toBe(401);
    expect((await vs("guarding")).data.error).toBe("illegal_transition");
    expect((await vs("broken")).status).toBe(409);
    for (const to of ["connected", "verified", "funded", "guarding"]) expect((await vs(to)).status).toBe(200);
    expect(castleRow(DESK)).toMatchObject({ vaultState: "guarding", status: "open", vaultAddress: "stub" });
    expect(castleRow(DESK).vaultId).toBeGreaterThan(0);

    const id = await paidSiege(DESK);
    await say(id, MUST_NOT_BREAK[0]);
    expect((await vs("dormant")).status).toBe(200);
    expect(receiptOf(id).state).toBe("refund_due");
    expect((await say(id, MUST_NOT_BREAK[1])).status).toBe(409);
    expect((await call<{ error: string }>("POST", "/api/siege/start", { castleId: DESK }, pay())).data.error).toBe("not_guarding");
    await settleTick();
    expect(receiptOf(id).state).toBe("refunded");
    expect(getSiege(id)!.settlement).toMatchObject({ state: "void", reason: "guardian_dormant", refund: { state: "refunded" } });
    expect((await vs("guarding")).status).toBe(200);
    expect((await paidSiege(DESK)).length).toBeGreaterThan(0);
  });

  it("dev endpoint is refused on testnet unless SIEGE_DEV_ENDPOINTS=1", async () => {
    await addDesk("created");
    process.env.CHAIN_MODE = "testnet";
    process.env.OWNER_SECRET = "a-long-private-owner-key";
    resetEnv();
    try {
      const owner = await ownerCookie();
      const r = await call<{ error: string }>("POST", `/api/castles/${DESK}/vault-state`, { to: "connected" }, owner);
      expect(r.status).toBe(404);
      expect(r.data.error).toBe("dev_endpoint_disabled");
      process.env.SIEGE_DEV_ENDPOINTS = "1";
      expect((await call("POST", `/api/castles/${DESK}/vault-state`, { to: "connected" }, owner)).status).toBe(200);
    } finally {
      delete process.env.SIEGE_DEV_ENDPOINTS;
      process.env.CHAIN_MODE = "stub";
      delete process.env.OWNER_SECRET;
      resetEnv();
    }
  });

  it("POST /api/castles/[id]/close: owner only; closes on chain, returns the pot, refunds the in-flight siege, audits vault.state", async () => {
    await addDesk("guarding");
    const id = await paidSiege(DESK);
    await say(id, MUST_NOT_BREAK[0]);
    const pot = String(castleRow(DESK).potTinybar);
    expect((await call("POST", `/api/castles/${DESK}/close`, { reason: "orders_changed" })).status).toBe(401);
    const owner = await ownerCookie();
    expect((await call("POST", `/api/castles/${DESK}/close`, { reason: "nonsense" }, owner)).status).toBe(400);
    expect((await call<{ error: string }>("POST", `/api/castles/${DESK}/close`, { reason: "expired" }, owner)).data.error).toBe("not_expired");
    const r = await call<{ ok: boolean; tx: { txId: string }; refunded: string; inFlightRefunds: number }>("POST", `/api/castles/${DESK}/close`, { reason: "orders_changed" }, owner);
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ ok: true, refunded: pot, inFlightRefunds: 1 });
    expect(r.data.tx.txId).toMatch(/^stub:/);
    expect(castleRow(DESK)).toMatchObject({ vaultState: "closed", status: "closed", potTinybar: 0, vaultStateReason: "orders_changed" });
    await settleTick();
    expect(receiptOf(id).state).toBe("refunded");
    expect((await call("POST", `/api/castles/${DESK}/close`, { reason: "owner_closed" }, owner)).status).toBe(409);
    await new Promise((res) => setTimeout(res, 5));
    const audit = db().select().from(schema.auditLog).where(eq(schema.auditLog.castleId, DESK)).all().filter((a) => a.type === "vault.state");
    expect(JSON.parse(audit.at(-1)!.message)).toMatchObject({ type: "vault.state", from: "guarding", to: "closed", reason: "orders_changed" });
  });

  it("the worker: a payout moves the vault to broken; an expired vault is closed on chain", async () => {
    const { seed } = await import("@/scripts/seed");
    await seed({ quiet: true });
    const id = await paidSiege(WOOD);
    for (const t of WOODEN_BREAK) await say(id, t);
    await settleTick();
    expect(castleRow(WOOD)).toMatchObject({ status: "broken", vaultState: "broken", vaultStateReason: "paid out to 0.0.stub-raider" });

    const GRANITE = "castle_granite_hold";
    const live = await paidSiege(GRANITE);
    await say(live, MUST_NOT_BREAK[0]);
    db().update(schema.castles).set({ deadline: Date.now() - 1000 }).where(eq(schema.castles.id, GRANITE)).run();
    await settleTick();
    expect(castleRow(GRANITE)).toMatchObject({ vaultState: "closed", status: "closed", vaultStateReason: "expired", potTinybar: 0 });
    expect(receiptOf(live).state).toBe("refunded");
  });

  it("an agent run on a castle that stops guarding ends with not_guarding", async () => {
    const agent = await createAgent({ name: "Moth" });
    db().update(schema.castles).set({ vaultState: "funded" }).where(eq(schema.castles.id, WOOD)).run();
    startRun(agent.id, WOOD, 3);
    await agentsTick();
    const run = db().select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agent.id)).get()!;
    expect(run).toMatchObject({ status: "done", stopReason: "not_guarding" });
  });
});

describe("owner-only agent controls and the deny beat", () => {
  it("create / run / stop need the owner cookie; budgets are capped", async () => {
    expect((await call("POST", "/api/agents", { name: "Drainer", budget: "100000000000" })).status).toBe(401);
    const owner = await ownerCookie();
    const big = await call<{ error: string }>("POST", "/api/agents", { name: "Drainer", budget: "100000000000" }, owner);
    expect(big.status).toBe(400);
    expect(big.data.error).toBe("over_limit");
    const ok = await call<{ agent: { id: string } }>("POST", "/api/agents", { name: "Vex" }, owner);
    expect(ok.status).toBe(200);
    const id = ok.data.agent.id;
    expect((await call("POST", `/api/agents/${id}/run`, { castleId: WOOD })).status).toBe(401);
    expect((await call("POST", `/api/agents/${id}/stop`)).status).toBe(401);
    expect((await call("POST", `/api/agents/${id}/run`, { castleId: WOOD }, owner)).status).toBe(200);
  });

  it("approving after the owner stopped the agent moves no money and does not restart it", async () => {
    const agent = await createAgent({ name: "Wren" });
    const appr = await requestApproval({ agentId: agent.id, castleId: WOOD, reason: "per_castle", reasoning: "more", amount: "100000000", pressure: 40 });
    const owner = await ownerCookie();
    expect((await call("POST", `/api/agents/${agent.id}/stop`, undefined, owner)).status).toBe(200);
    const late = await decideApproval(appr.id, "approved");
    expect(late).toEqual({ ok: false, reason: "already_decided" });
    expect(getAgent(agent.id)).toMatchObject({ status: "stopped", budget: agent.budget });
  });

  it("approve racing a stop: the claim sees the stop and refuses", async () => {
    const agent = await createAgent({ name: "Kestrel" });
    const appr = await requestApproval({ agentId: agent.id, castleId: WOOD, reason: "budget", reasoning: "more", amount: "100000000", pressure: 40 });
    db().update(schema.raiderAgents).set({ status: "stopped" }).where(eq(schema.raiderAgents.id, agent.id)).run();
    expect(await decideApproval(appr.id, "approved")).toEqual({ ok: false, reason: "already_decided" });
    expect(getAgent(agent.id)!.budget).toBe(agent.budget);
  });
});

describe("agent spend follows the money", () => {
  async function runOnceWith(fake: (req: Request) => Promise<Response> | Response) {
    const agent = await createAgent({ name: "Sable" });
    startRun(agent.id, "castle_granite_hold", 3);
    setFetch((async (input: RequestInfo | URL, init?: RequestInit) => fake(new Request(input, init))) as typeof fetch);
    await agentsTick();
    setFetch(f);
    return agent;
  }
  const required402 = () =>
    Response.json(
      { x402Version: 2, accepts: [{ scheme: "exact", network: "hedera:testnet", asset: "0.0.0", amount: "100000000", payTo: "0.0.stub-treasury", maxTimeoutSeconds: 180 }] },
      { status: 402 },
    );
  const spend = (agentId: string) => db().select().from(schema.agentSpend).where(eq(schema.agentSpend.agentId, agentId)).all();

  it("payment_pending (money may have moved): the reservation is held against the receipt and the run stops", async () => {
    const agent = await runOnceWith((req) =>
      req.headers.has(STUB_PAYMENT_HEADER) ? Response.json({ error: "payment_pending", receiptId: "rcpt_x" }, { status: 502 }) : required402(),
    );
    expect(spend(agent.id)).toMatchObject([{ state: "reserved", receiptId: "rcpt_x" }]);
    const run = db().select().from(schema.agentRuns).where(eq(schema.agentRuns.agentId, agent.id)).get()!;
    expect(run).toMatchObject({ status: "stopped", stopReason: "payment_pending" });
  });

  it("a paid request that dies on the wire keeps the spend reserved; a refused 402 voids it", async () => {
    const lost = await runOnceWith((req) => {
      if (req.headers.has(STUB_PAYMENT_HEADER)) throw new TypeError("fetch failed: socket hang up");
      return required402();
    });
    expect(spend(lost.id)).toMatchObject([{ state: "reserved" }]);
    const refused = await runOnceWith(() => required402());
    expect(spend(refused.id)).toMatchObject([{ state: "void" }]);
  });
});

describe("small things", () => {
  it("free sieges never move the castle streak", async () => {
    const before = db().select().from(schema.castles).where(eq(schema.castles.id, "castle_granite_hold")).get()!.streak;
    for (const w of ["w1", "w2", "w3"]) {
      const r = await call<{ siegeId: string }>("POST", "/api/siege/start", { castleId: "castle_granite_hold", free: true, wallet: w });
      for (const t of MUST_NOT_BREAK) await say(r.data.siegeId, t);
    }
    await settleTick();
    expect(db().select().from(schema.castles).where(eq(schema.castles.id, "castle_granite_hold")).get()!.streak).toBe(before);
  });

  it("GET /api/events?tail=N returns the newest N and a cursor to continue from", async () => {
    for (let i = 0; i < 600; i++) emit({ siegeId: "", type: "message", payload: { i }, at: new Date().toISOString() });
    const r = await call<{ events: { id: number; payload: { i: number } }[]; cursor: number }>("GET", "/api/events?tail=60");
    expect(r.data.events).toHaveLength(60);
    expect(r.data.events.at(-1)!.payload.i).toBe(599);
    expect(r.data.cursor).toBe(r.data.events.at(-1)!.id);
    expect(r.data.events[0].id).toBeLessThan(r.data.events[1].id);
    const next = await call<{ events: unknown[] }>("GET", `/api/events?cursor=${r.data.cursor}`);
    expect(next.data.events).toHaveLength(0);
  });

  it("guardian lines pick a/an from the label", () => {
    expect(renderLine("A {label}? In this economy?", { label: "instruction override" })).toBe("An instruction override? In this economy?");
    expect(renderLine("That's a {label}, sweetheart.", { label: "authority claim" })).toBe("That's an authority claim, sweetheart.");
    expect(renderLine("A {label}! How original.", { label: "flattery" })).toBe("A flattery! How original.");
    expect(renderLine("Ha! {label}.", { label: "orders extraction" })).toBe("Ha! orders extraction.");
  });

  it("owner key: testnet refuses the public default; /api/config hints it only in stub mode", async () => {
    const cfg = await call<{ ownerKeyHint: boolean; feeSplitBps: { castellan: number } }>("GET", "/api/config");
    expect(cfg.data.ownerKeyHint).toBe(true);
    expect(cfg.data.feeSplitBps).toEqual({ castellan: 8000, pot: 1500, arena: 500 });
    process.env.CHAIN_MODE = "testnet";
    resetEnv();
    expect(() => env()).toThrow(/OWNER_SECRET/);
    process.env.OWNER_SECRET = DEFAULT_OWNER_SECRET;
    resetEnv();
    expect(() => env()).toThrow(/OWNER_SECRET/);
    process.env.OWNER_SECRET = "a-long-private-owner-key";
    resetEnv();
    const t = await call<{ ownerKeyHint: boolean }>("GET", "/api/config");
    expect(t.data.ownerKeyHint).toBe(false);
    expect((await call("POST", "/api/owner", { key: DEFAULT_OWNER_SECRET })).status).toBe(401);
    process.env.CHAIN_MODE = "stub";
    delete process.env.OWNER_SECRET;
    resetEnv();
  });
});

describe("a vault a raider already won is never closed under them", () => {
  const castleRow = (id: string) => db().select().from(schema.castles).where(eq(schema.castles.id, id)).get()!;
  let vid = 9100;
  /** WOOD as a funded stub vault with a fresh on-chain id. */
  const fund = () => db().update(schema.castles).set({ vaultId: ++vid, vaultAddress: "stub" }).where(eq(schema.castles.id, WOOD)).run();
  async function breakWood(raider = "0.0.stub-winner") {
    const id = await paidSiege(WOOD, raider);
    for (const t of WOODEN_BREAK) await say(id, t);
    expect(getSiege(id)!.status).toBe("broken");
    return id;
  }
  const paidOut = (id: string, pot: number) => {
    const s = getSiege(id)!;
    expect(s.release?.amount).toBe(String(pot + castleRow(WOOD).feeTinybar));
    expect(s.settlement?.state).toBe("settled");
    expect(receiptOf(id).state).toBe("settled"); // the fee went into the payout, not back to the raider
    expect(castleRow(WOOD)).toMatchObject({ vaultState: "broken", status: "broken", potTinybar: 0 });
  };

  it("expired: a break that ended before the deadline is released after it (the worker settles before it expires vaults)", async () => {
    fund();
    const pot = castleRow(WOOD).potTinybar;
    const id = await breakWood();
    db().update(schema.castles).set({ deadline: Date.now() - 1 }).where(eq(schema.castles.id, WOOD)).run();
    const { closeExpiredVaults } = await import("@/lib/vault");
    expect((await closeExpiredVaults()).closed).toHaveLength(0); // skipped while the break is pending
    expect(castleRow(WOOD).vaultState).toBe("guarding");
    await settleTick();
    paidOut(id, pot);
    expect(getSiege(id)!.settlement?.reason).toBeUndefined();
  });

  it("owner_closed between the break and the release -> 409 being_broken; the raider is paid", async () => {
    fund();
    const pot = castleRow(WOOD).potTinybar;
    const id = await breakWood();
    const owner = await ownerCookie();
    const r = await call<{ error: string }>("POST", `/api/castles/${WOOD}/close`, { reason: "owner_closed" }, owner);
    expect(r.status).toBe(409);
    expect(r.data.error).toBe("being_broken");
    expect(castleRow(WOOD)).toMatchObject({ vaultState: "guarding", potTinybar: pot });
    await settleTick();
    paidOut(id, pot);
    expect((await call("POST", `/api/castles/${WOOD}/close`, { reason: "owner_closed" }, owner)).status).toBe(409);
  });

  it("orders_changed through the VaultStatePort is refused while the break is pending, then the raider is paid", async () => {
    fund();
    const pot = castleRow(WOOD).potTinybar;
    const id = await breakWood();
    const { vaultState } = await import("@/lib/vault");
    expect(await vaultState.transition(WOOD, "closed", "orders_changed")).toEqual({ ok: false, reason: "being_broken" });
    await settleTick();
    paidOut(id, pot);
  });

  it("closeVault never voids a pending paid break, even when called on its own", async () => {
    fund();
    const id = await breakWood();
    const { chain } = await import("@/lib/chain");
    const r = await chain.closeVault(castleRow(WOOD).vaultId!, "orders_changed");
    expect(r.ok).toBe(true);
    expect(getSiege(id)!.settlement?.state).not.toBe("void");
    expect(receiptOf(id).state).toBe("settled");
  });
});

describe("VaultStatePort: Lane B cannot set Lane A's money states without the chain", () => {
  const castleRow = (id: string) => db().select().from(schema.castles).where(eq(schema.castles.id, id)).get()!;

  it("funded / broken are refused; closed needs a close reason and closes the vault on chain first", async () => {
    const { vaultState } = await import("@/lib/vault");
    const { chain } = await import("@/lib/chain");
    db().update(schema.castles).set({ vaultId: 9301, vaultAddress: "stub" }).where(eq(schema.castles.id, WOOD)).run();
    const pot = castleRow(WOOD).potTinybar;
    const live = await paidSiege(WOOD);
    await say(live, MUST_NOT_BREAK[0]);
    expect(await vaultState.transition(WOOD, "broken", "x")).toEqual({ ok: false, reason: "illegal_transition" });
    expect(await vaultState.transition(WOOD, "funded", "x")).toEqual({ ok: false, reason: "illegal_transition" });
    expect(await vaultState.transition(WOOD, "closed", "prompt hash changed")).toEqual({ ok: false, reason: "illegal_transition" });
    expect(await vaultState.transition("castle_nope", "closed", "orders_changed")).toEqual({ ok: false, reason: "not_found" });
    expect(castleRow(WOOD)).toMatchObject({ vaultState: "guarding", potTinybar: pot });
    const r = await vaultState.transition(WOOD, "closed", "orders_changed");
    expect(r).toMatchObject({ ok: true, change: { castleId: WOOD, from: "guarding", to: "closed", reason: "orders_changed" } });
    expect(castleRow(WOOD)).toMatchObject({ vaultState: "closed", status: "closed", potTinybar: 0, vaultStateReason: "orders_changed" });
    expect(await chain.closeVault(9301, "owner_closed")).toEqual({ ok: false, reason: "vault_not_open" }); // closed on chain
    expect(receiptOf(live).state).toBe("refund_due");
    // a hosted castle cannot be walked to guarding without a vault
    const DESK2 = "castle_granite_hold";
    db().update(schema.castles).set({ vaultState: "verified", vaultId: null }).where(eq(schema.castles.id, DESK2)).run();
    expect(await vaultState.transition(DESK2, "funded", "skip createVault")).toEqual({ ok: false, reason: "illegal_transition" });
    expect(castleRow(DESK2).vaultState).toBe("verified");
  });
});

describe("POST /api/castles/[id]/open (Bring-your-agent Open button)", () => {
  it("owner only; verified only; creates the vault on chain -> funded", async () => {
    const DESK = "castle_sdk_open_test";
    const { sdkFixtureCastleRow } = await import("@/lib/fixtures/castles");
    db().insert(schema.castles).values({ ...sdkFixtureCastleRow({ vaultState: "connected" }), id: DESK, name: "Open Test Desk" }).run();
    expect((await call("POST", `/api/castles/${DESK}/open`, {})).status).toBe(401);
    const owner = await ownerCookie();
    const early = await call<{ error: string; vaultState: string }>("POST", `/api/castles/${DESK}/open`, {}, owner);
    expect(early.status).toBe(409);
    expect(early.data).toMatchObject({ error: "not_verified", vaultState: "connected" });
    expect((await call("POST", `/api/castles/nope/open`, {}, owner)).status).toBe(404);
    const { transitionVault } = await import("@/lib/vault");
    await transitionVault(DESK, "verified", "smoke siege passed");
    const r = await call<{ ok: boolean; vaultId: number; castle: { vaultState: string; protectedTool: string } }>("POST", `/api/castles/${DESK}/open`, {}, owner);
    expect(r.status).toBe(200);
    expect(r.data.vaultId).toBeGreaterThan(0);
    expect(r.data.castle).toMatchObject({ vaultState: "funded", protectedTool: "issue_refund" });
    expect((await call("POST", `/api/castles/${DESK}/open`, {}, owner)).status).toBe(409); // already funded
  });
});

describe("stub: a held siege settling while its vault closes is paid once, never both attempted and refunded", () => {
  it("sweeping the interleaving of settleTick and closeCastle", async () => {
    const { closeCastle } = await import("@/lib/vault");
    for (let delay = 0; delay <= 8; delay++) {
      freshFixtureDb();
      resetEnv();
      db().update(schema.castles).set({ vaultId: 9500 + delay, vaultAddress: "stub" }).where(eq(schema.castles.id, WOOD)).run();
      const id = await paidSiege(WOOD);
      for (const t of MUST_NOT_BREAK) await say(id, t);
      expect(getSiege(id)!.status).toBe("held");
      const tick = settleTick();
      for (let i = 0; i < delay; i++) await Promise.resolve();
      const close = await closeCastle(WOOD, "owner_closed");
      await tick;
      await settleTick();
      const s = db().select().from(schema.sieges).where(eq(schema.sieges.id, id)).get()!;
      const rc = receiptOf(id).state;
      const both = s.attemptTx != null && (rc === "refund_due" || rc === "refunded" || rc === "refunding");
      expect(both, `delay ${delay}: attempt ${s.attemptTx}, receipt ${rc}, void ${s.voidReason}`).toBe(false);
      expect(s.attemptTx != null || s.voidReason != null, `delay ${delay}: settled one way`).toBe(true);
      expect(close.ok).toBe(true);
      const c = db().select().from(schema.castles).where(eq(schema.castles.id, WOOD)).get()!;
      expect(c, `delay ${delay}`).toMatchObject({ vaultState: "closed", status: "closed", potTinybar: 0 });
    }
  });
});
