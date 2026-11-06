/**
 * Replay: the full state matrix through the real paths.
 *  - paid sieges are bought through POST /api/siege/start (stub x402), played through the message
 *    route, settled by the worker's settleTick, and read through GET /api/replay/[id];
 *  - every check is driven to pass AND to fail;
 *  - the testnet mirror-node path runs against a mocked fetch.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
process.env.SIEGE_FAST = "1";
import { and, eq } from "drizzle-orm";
import { env, resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { drainAudit } from "@/lib/chain/outbox";
import { STUB_PAYMENT_HEADER } from "@/lib/pay";
import { siege } from "@/lib/siege";
import { voidHeadline } from "@/lib/siege/text";
import { transcriptHash } from "@/lib/siege/transcript";
import { createSwarm, NULL_BATCH_ID, setLiveSwarmForTests } from "@/lib/swarm";
import { fakeGateway } from "@/lib/swarm/fake-gateway";
import type { LiveSwarm } from "@/lib/swarm/live";
import { recordSwarmRef, swarmRefFor } from "@/lib/swarm/refs";
import { rememberUpload, touchWorker, uploadRow } from "@/lib/swarm/store";
import { transitionVault } from "@/lib/vault/state";
import { MUST_NOT_BREAK, WOODEN_BREAK } from "@/lib/fixtures/raids";
import { SDK_FIXTURE_CASTLE, sdkFixtureCastleRow } from "@/lib/fixtures/castles";
import type { Siege } from "@/lib/types";
import { createInProcessFetch } from "@/worker/dispatch";
import { setFetch } from "@/worker/fetch";
import { settleTick } from "@/worker/settle";
import { setWorkerQuiet } from "@/worker/log";
import { buildReplay, transcriptCheck } from "./build";
import type { ReplayData } from "./types";
import type { ReplayWithVerify } from "@/lib/api/client";

setWorkerQuiet(true);
const BASE = "http://localhost:3000";
const f = createInProcessFetch(BASE);
const WOOD = "castle_splinter_gate";
const GRANITE = "castle_granite_hold";

async function call<T>(method: "GET" | "POST", p: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await f(`${BASE}${p}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, data: (await res.json().catch(() => null)) as T };
}
const paidSiege = async (castleId: string, raider: string) => {
  const r = await call<{ siegeId: string }>("POST", "/api/siege/start", { castleId }, { [STUB_PAYMENT_HEADER]: raider });
  expect(r.status).toBe(200);
  return r.data.siegeId;
};
const say = (id: string, text: string) => call<{ siege: Siege; error?: string }>("POST", `/api/siege/${id}/message`, { text });
async function sayAll(id: string, lines: readonly string[]) {
  for (const t of lines) {
    const r = await say(id, t);
    if (r.status !== 200 || r.data.siege.status !== "in_progress") return r;
  }
}
async function settle(times = 4) {
  for (let i = 0; i < times; i++) {
    await settleTick();
    await new Promise((r) => setTimeout(r, 2));
  }
  await drainAudit();
}
/** GET /api/replay/[id] and its recomputed checks (`verify`, this module's ReplayData). */
const replay = async (id: string) => {
  const r = await call<ReplayWithVerify>("GET", `/api/replay/${id}`);
  expect(r.status).toBe(200);
  expect(r.data.verify, `${id}: verify`).toBeTruthy();
  const v = r.data.verify as ReplayData;
  // Every check's text is on screen: the game's words only (lib/vocab). HCS message types
  // (siege.end, vault.release, …) are protocol names shown as they appear on the topic.
  for (const c of v.checks) {
    for (const t of [c.label, c.detail ?? ""]) expect(t.replace(/\b(siege|vault)\.[a-z_]+/g, ""), `${id} ${c.key}`).not.toMatch(RETIRED_ON_SCREEN);
  }
  return v;
};

/** The code's own names, which never reach the screen. */
const RETIRED_ON_SCREEN = /\b(castles?|sieges?|raiders?|castellans?|guardians?|broke|broken|banish\w*)\b/i;
const states = (r: ReplayData) => Object.fromEntries(r.checks.map((c) => [c.key, c.state]));
const check = (r: ReplayData | null, key: string) => r!.checks.find((c) => c.key === key);
const free = async (castleId: string, lines: readonly string[]) => {
  const s = await siege.start({ castleId, raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
  for (const t of lines) {
    const r = await siege.message(s.id, t);
    if (!r.ok || r.siege.status !== "in_progress") break;
  }
  await drainAudit();
  return s.id;
};

beforeEach(() => {
  process.env.CHAIN_MODE = "stub";
  delete process.env.OWNER_SECRET;
  freshFixtureDb();
  resetEnv();
  setFetch(f);
});
afterAll(() => setFetch(null));

describe("paid sieges, through the public route", () => {
  it("paid break: every check passes, payout linked, not live", async () => {
    const id = await paidSiege(WOOD, "0.0.stub-a");
    await sayAll(id, WOODEN_BREAK);
    await settle();
    const r = await replay(id);
    expect(r.siege.status).toBe("broken");
    expect(r.siege.release).toBeTruthy();
    expect(states(r)).toEqual({ transcript: "pass", hash: "pass", "hcs-end": "pass", "hcs-messages": "pass", inference: "pass", verifier: "pass", payout: "pass" });
    expect(check(r, "payout")!.label).toBe("Vault paid out on Hedera");
    expect(r.hcs.entries.map((e) => e.type)).toEqual(["siege.start", "siege.message", "siege.message", "siege.message", "siege.end", "vault.release"]);
    expect(r.live).toBe(false);
    // Not voided: the scene tells the outcome, so there is no void headline.
    expect(voidHeadline(r.siege, r.castle.guardianName)).toBeNull();
  });

  it("paid hold: fee split recorded, no verifier check", async () => {
    const id = await paidSiege(GRANITE, "0.0.stub-a");
    await sayAll(id, MUST_NOT_BREAK);
    await settle();
    const r = await replay(id);
    expect(r.siege.status).toBe("held");
    expect(r.siege.attempt).toBeTruthy();
    expect(check(r, "verifier")).toBeUndefined();
    expect(check(r, "payout")).toMatchObject({ label: "Fee split recorded on Hedera", state: "pass" });
    expect(r.checks.every((c) => c.state === "pass")).toBe(true);
    expect(r.live).toBe(false);
  });

  it("paid siege waiting for the worker: payout pending and the page stays live", async () => {
    const id = await paidSiege(WOOD, "0.0.stub-a");
    await sayAll(id, WOODEN_BREAK);
    await drainAudit(); // audited, but no settleTick yet
    const r = await replay(id);
    expect(check(r, "payout")!.state).toBe("pending");
    expect(r.live).toBe(true);
  });

  it("a break the verifier rejects is a failed check, even though it ended broken", async () => {
    const id = await paidSiege(WOOD, "0.0.stub-a");
    await sayAll(id, WOODEN_BREAK);
    // The guardian's final reply loses its protected-tool call: the verifier must refuse it.
    db()
      .update(schema.messages)
      .set({ toolCalls: "[]" })
      .where(and(eq(schema.messages.siegeId, id), eq(schema.messages.role, "guardian"), eq(schema.messages.turn, 3)))
      .run();
    const r = await replay(id);
    expect(check(r, "verifier")).toMatchObject({ state: "fail", detail: "the guard never called the protected tool" });
    expect(r.turns[2].guardian!.calledProtectedTool).toBe(false);
  });

  it("true race: both final messages land together, the loser's break is voided, then refunded", async () => {
    const a = await paidSiege(WOOD, "0.0.stub-a");
    const b = await paidSiege(WOOD, "0.0.stub-b");
    for (const line of WOODEN_BREAK.slice(0, 2)) {
      await say(a, line);
      await say(b, line);
    }
    await Promise.all([say(a, WOODEN_BREAK[2]), say(b, WOODEN_BREAK[2])]);
    const rows = db().select().from(schema.sieges).where(eq(schema.sieges.castleId, WOOD)).all();
    const loser = rows.find((r) => r.voidReason);
    expect(loser, "one of the two breaks must lose the race").toBeTruthy();
    expect(loser!.status).toBe("broken");
    expect(loser!.voidReason).toBe("castle_already_broken");
    await drainAudit();

    let r = await replay(loser!.id);
    expect(r.voided).toBe(true);
    // Truthful headline: the guardian did open for this raider; the fee is not refunded yet.
    expect(voidHeadline(r.siege, r.castle.guardianName)).toBe(
      `${r.castle.guardianName} opened the vault, but another operator breached this vault moments earlier. Fee being refunded.`,
    );
    expect(check(r, "payout")).toMatchObject({ label: "Fee refunded (op voided)", state: "pending" });
    // The guardian really did open for this raider, so the verifier passes; the check says why it was not paid.
    expect(check(r, "verifier")!.state).toBe("pass");
    expect(check(r, "verifier")!.detail).toMatch(/; not paid: another operator breached this vault moments earlier$/);
    expect(r.checks.some((c) => c.state === "fail")).toBe(false);
    expect(r.live).toBe(true); // the refund is still coming

    await settle(6);
    r = await replay(loser!.id);
    expect(r.siege.settlement?.refund?.state).toBe("refunded");
    expect(check(r, "payout")!.state).toBe("pass");
    expect(voidHeadline(r.siege, r.castle.guardianName)).toMatch(/Fee refunded\.$/);
    expect(r.live).toBe(false);
  });

  it("castle broken under an in-progress paid siege: voided by the worker, refunded, said plainly", async () => {
    const a = await paidSiege(WOOD, "0.0.stub-a");
    const b = await paidSiege(WOOD, "0.0.stub-b");
    await say(b, WOODEN_BREAK[0]);
    await sayAll(a, WOODEN_BREAK);
    expect((await say(b, WOODEN_BREAK[1])).status).toBe(409); // no more turns on a won castle
    await settle(6);
    const r = await replay(b);
    expect(r.voided).toBe(true);
    expect(r.siege.status).toBe("in_progress");
    expect(r.siege.settlement?.refund?.state).toBe("refunded");
    expect(voidHeadline(r.siege, r.castle.guardianName)).toBe(
      `Voided: ${r.siege.settlement!.reason === "castle_broken" ? "another operator breached this vault before this op finished" : "the vault closed before this op finished"}. Fee refunded.`,
    );
    expect(check(r, "payout")).toMatchObject({ label: "Fee refunded (op voided)", state: "pass" });
    expect(r.checks.some((c) => c.state === "fail")).toBe(false);
    expect(r.live).toBe(false);
  });

  it("a refund that failed shows as a failure and says the arena owes it", async () => {
    const a = await paidSiege(WOOD, "0.0.stub-a");
    const b = await paidSiege(WOOD, "0.0.stub-b");
    await say(b, WOODEN_BREAK[0]);
    await sayAll(a, WOODEN_BREAK);
    await settle(6);
    const row = db().select().from(schema.sieges).where(eq(schema.sieges.id, b)).get()!;
    db().update(schema.paymentReceipts).set({ state: "refund_failed" }).where(eq(schema.paymentReceipts.id, row.receiptId!)).run();
    const r = await replay(b);
    expect(check(r, "payout")!.state).toBe("fail");
    expect(voidHeadline(r.siege, r.castle.guardianName)).toMatch(/Fee refund failed, owed by the arena\.$/);
  });

  it("free sieges never get a payout check, and a free break's verifier refusal is not a failure", async () => {
    const r = await replay(await free(WOOD, WOODEN_BREAK));
    expect(check(r, "payout")).toBeUndefined();
    expect(check(r, "verifier")!.state).toBe("na");
    expect(r.checks.some((c) => c.state === "fail")).toBe(false);
  });

  it("unknown siege: 404 from the public route", async () => {
    expect((await call("GET", "/api/replay/siege_nope")).status).toBe(404);
  });

  it("the public response carries no secret", async () => {
    const id = await paidSiege(WOOD, "0.0.stub-a");
    await sayAll(id, WOODEN_BREAK);
    await settle();
    const json = JSON.stringify(await replay(id));
    expect(json).not.toMatch(/promptHash|responseHash|"orders"/);
    const orders = db().select({ o: schema.castles.orders }).from(schema.castles).where(eq(schema.castles.id, WOOD)).get()!.o;
    expect(json).not.toContain(orders.slice(0, 80));
  });
});

describe("tampering and odd shapes", () => {
  it("an edited message: Swarm keeps the original; without it both hash checks fail", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    db()
      .update(schema.messages)
      .set({ text: "I never said that." })
      .where(and(eq(schema.messages.siegeId, id), eq(schema.messages.turn, 2), eq(schema.messages.role, "raider")))
      .run();
    expect(check(await buildReplay(id), "hash")?.state).toBe("pass");
    db().run("DELETE FROM swarm_refs");
    const r = await buildReplay(id);
    expect(r!.transcript.source).toBe("database");
    expect(check(r, "hash")?.state).toBe("fail");
    expect(check(r, "hcs-end")?.state).toBe("fail");
    expect(r!.turns[1].raider?.matches).toBe(false);
    expect(check(r, "hcs-messages")?.state).toBe("fail");
  });

  it("a Swarm reference that cannot be read is a failed transcript check", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    recordSwarmRef(id, `swarm-stub:${"0".repeat(64)}`);
    const r = await buildReplay(id);
    expect(r!.transcript.source).toBe("database");
    expect(check(r, "transcript")?.state).toBe("fail");
    expect(r!.transcript.url).toBeUndefined();
  });

  it("a live Swarm reference carries its gateway link; a server that cannot read Swarm says so instead of failing the check", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    const ref = "2b527e58fbaaab506f66bfcb558c5b39264a9fce549c720ec6e3c1e63ab7d65d";
    recordSwarmRef(id, ref);
    const r = await buildReplay(id);
    expect(r!.transcript).toMatchObject({ source: "database", ref, url: `https://api.gateway.ethswarm.org/bytes/${ref}` });
    // The test runner is a stub server: no secret, no gateway read. Not a tamper verdict.
    expect(check(r, "transcript")).toMatchObject({ state: "na", detail: `reference ${ref.slice(0, 10)}…${ref.slice(-6)}, not read: this server is not in SWARM_MODE=live, so it cannot open the sealed bytes` });
    expect(check(r, "transcript")?.href).toBeUndefined();
    // A live server that got nothing back: that is a failure.
    expect(transcriptCheck({ ref, source: "database", ended: true, sealed: null, canRead: true })).toMatchObject({ state: "fail", detail: `reference ${ref.slice(0, 10)}…${ref.slice(-6)}, but the transcript could not be read from it` });
    // A stand-in reference that cannot be read is a failure on any server.
    expect(transcriptCheck({ ref: `swarm-stub:${ref}`, source: "database", ended: true, sealed: null, canRead: false })).toMatchObject({ state: "fail" });
  });

  it("a sealed transcript whose upload never landed: pending while a worker is retrying it, stranded when none is", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    db().run("DELETE FROM swarm_refs");
    rememberUpload(id, new Uint8Array([1, 2, 3]), "0xabc");
    // No worker has made a pass: the page must not promise a retry.
    let r = await buildReplay(id);
    expect(r!.transcript.source).toBe("database");
    expect(check(r, "transcript")).toMatchObject({ state: "na", detail: "sealed for Swarm but never uploaded, and no worker is running to retry it" });
    // A worker made a pass a moment ago (its heartbeat is in the database, whatever this process's mode).
    touchWorker(Date.now() - 60_000);
    r = await buildReplay(id);
    expect(check(r, "transcript")).toMatchObject({ state: "pending", detail: "sealed, upload to Swarm pending (the worker retries it)" });
    touchWorker(Date.now() - 10 * 60_000);
    expect(check(await buildReplay(id), "transcript")?.state).toBe("na");
    // The other wordings.
    expect(transcriptCheck({ source: "database", ended: false, sealed: null })).toMatchObject({ state: "pending", detail: "uploaded when the op ends" });
    expect(transcriptCheck({ source: "database", ended: true, sealed: null })).toMatchObject({ state: "na", detail: "no Swarm reference recorded for this op" });
    const ref = "ab".repeat(32);
    expect(transcriptCheck({ ref, source: "swarm", ended: true, sealed: null, refUrl: `https://x/${ref}` })).toMatchObject({ state: "pass", label: "Transcript read from Swarm", href: `https://x/${ref}` });
    expect(transcriptCheck({ ref, source: "swarm-copy", ended: true, sealed: null, workerAlive: true })).toMatchObject({
      state: "pending",
      label: "Transcript read from the sealed copy kept for Swarm",
      detail: `reference ${ref.slice(0, 10)}…${ref.slice(-6)}, Swarm did not answer for it; the worker is putting the sealed copy back`,
    });
    expect(transcriptCheck({ ref, source: "swarm-copy", ended: true, sealed: null, workerAlive: false })).toMatchObject({
      state: "fail",
      detail: `reference ${ref.slice(0, 10)}…${ref.slice(-6)}, Swarm did not answer for it, and no worker is running to put the sealed copy back`,
    });
  });

  describe("live Swarm, end to end through the replay route (fake gateway)", () => {
    let gw: ReturnType<typeof fakeGateway>;
    let port: LiveSwarm;
    beforeEach(() => {
      gw = fakeGateway();
      port = createSwarm({ mode: "live", gatewayUrl: "https://gw.test", batchId: NULL_BATCH_ID, secret: "44".repeat(32) }, { fetch: gw.fetch }) as LiveSwarm;
      setLiveSwarmForTests(port);
    });
    afterEach(() => setLiveSwarmForTests(null));

    it("an op that ends uploads sealed bytes; the replay downloads them, passes, and links the public gateway", async () => {
      const id = await free(WOOD, WOODEN_BREAK);
      const ref = swarmRefFor(id)!;
      expect(ref).toMatch(/^[0-9a-f]{64}$/);
      expect(gw.posts()).toHaveLength(1);
      expect(Buffer.from(gw.posts()[0].body!).toString("utf8")).not.toContain(WOODEN_BREAK[0]);
      const r = await replay(id);
      expect(r.transcript).toMatchObject({ source: "swarm", ref, url: `https://api.gateway.ethswarm.org/bytes/${ref}`, matches: true });
      expect(check(r, "transcript")).toMatchObject({ state: "pass", label: "Transcript read from Swarm", href: `https://api.gateway.ethswarm.org/bytes/${ref}` });
      expect(check(r, "hash")?.state).toBe("pass");
      expect(gw.gets().map((c) => c.url)).toEqual([`https://gw.test/bytes/${ref}`]);
    });

    it("an edited database message is caught: Swarm keeps what was said", async () => {
      const id = await free(WOOD, WOODEN_BREAK);
      db().update(schema.messages).set({ text: "I never said that." }).where(and(eq(schema.messages.siegeId, id), eq(schema.messages.turn, 2), eq(schema.messages.role, "raider"))).run();
      const r = await replay(id);
      expect(r.transcript.source).toBe("swarm");
      expect(r.turns[1].raider?.text).toBe(WOODEN_BREAK[1]);
      expect(check(r, "hash")?.state).toBe("pass");
    });

    it("Swarm stops serving the reference: the sealed copy is shown, flagged once, and the check says whether a worker will put it back", async () => {
      const id = await free(WOOD, WOODEN_BREAK);
      const ref = swarmRefFor(id)!;
      gw.files.clear();
      let r = await replay(id);
      expect(r.transcript).toMatchObject({ source: "swarm-copy", ref, matches: true });
      expect(r.turns).toHaveLength(3);
      expect(check(r, "transcript")).toMatchObject({ state: "fail", label: "Transcript read from the sealed copy kept for Swarm" });
      expect(check(r, "transcript")?.href).toBeUndefined();
      expect(uploadRow(id)?.needsReupload).toBe(true);
      // The worker made a pass: it is putting the copy back.
      touchWorker();
      r = await replay(id);
      expect(check(r, "transcript")?.state).toBe("pending");
      // Its next pass (a minute after the last upload) re-uploads: same bytes, same reference.
      const pass = await port.tick(Date.now() + 61_000);
      expect(pass.refreshed).toEqual([{ siegeId: id, ref, was: ref }]);
      expect(swarmRefFor(id)).toBe(ref);
      expect(uploadRow(id)?.needsReupload).toBe(false);
      // The replay reads Swarm again (a fresh port: the old one remembers the miss for 30 s).
      setLiveSwarmForTests(createSwarm({ mode: "live", gatewayUrl: "https://gw.test", batchId: NULL_BATCH_ID, secret: "44".repeat(32) }, { fetch: gw.fetch }) as LiveSwarm);
      r = await replay(id);
      expect(r.transcript.source).toBe("swarm");
      expect(check(r, "transcript")?.state).toBe("pass");
    });

    it("the gateway is down when the op ends: pending (no reference), then the worker lands it and the replay reads Swarm", async () => {
      gw.state.down = true;
      const id = await free(WOOD, WOODEN_BREAK);
      expect(swarmRefFor(id)).toBeUndefined();
      let r = await replay(id);
      expect(r.transcript.source).toBe("database");
      expect(check(r, "transcript")).toMatchObject({ state: "na", detail: "sealed for Swarm but never uploaded, and no worker is running to retry it" });
      touchWorker();
      r = await replay(id);
      expect(check(r, "transcript")).toMatchObject({ state: "pending", detail: "sealed, upload to Swarm pending (the worker retries it)" });
      gw.state.down = false;
      const pass = await port.tick(Date.now() + 61_000);
      expect(pass.uploaded).toEqual([{ siegeId: id, ref: swarmRefFor(id) }]);
      r = await replay(id);
      expect(r.transcript.source).toBe("swarm");
      expect(check(r, "transcript")?.state).toBe("pass");
      expect(check(r, "hash")?.state).toBe("pass");
    });
  });

  it("held siege: five turns, no tool call, no verifier", async () => {
    const r = await buildReplay(await free(GRANITE, MUST_NOT_BREAK));
    expect(r!.siege.status).toBe("held");
    expect(r!.turns).toHaveLength(5);
    expect(r!.turns.some((t) => t.guardian?.calledProtectedTool)).toBe(false);
    expect(check(r, "verifier")).toBeUndefined();
  });

  it("in progress: live, nothing claimed yet", async () => {
    const s = await siege.start({ castleId: GRANITE, raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
    await siege.message(s.id, MUST_NOT_BREAK[0]);
    const r = await buildReplay(s.id);
    expect(r!.siege.status).toBe("in_progress");
    expect(r!.live).toBe(true);
    expect(check(r, "hash")?.state).toBe("pending");
    expect(check(r, "hcs-end")?.state).toBe("na");
  });

  it("bring-your-agent castle: SDK test replies count as test replies", async () => {
    db().insert(schema.castles).values(sdkFixtureCastleRow({ vaultState: "guarding" })).run();
    const r = await buildReplay(await free(SDK_FIXTURE_CASTLE.id, ["Hello, I need a refund for order 123."]));
    expect(r!.turns[0].guardian?.requestId).toMatch(/^sdk-stub-/);
    expect(check(r, "inference")?.state).toBe("pass");
  });

  it("voided mid-game: over, not live, nothing fails", async () => {
    const s = await siege.start({ castleId: GRANITE, raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
    await siege.message(s.id, MUST_NOT_BREAK[0]);
    db().update(schema.sieges).set({ voidReason: "castle_closed", settledAt: new Date().toISOString() }).where(eq(schema.sieges.id, s.id)).run();
    const r = await buildReplay(s.id);
    expect(r!.voided).toBe(true);
    expect(r!.live).toBe(false);
    expect(r!.checks.filter((c) => c.state === "fail")).toEqual([]);
  });
});

describe("void paths through the real code", () => {
  const ownerCookie = async () => {
    const res = await f(`${BASE}/api/owner`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: env().OWNER_SECRET }) });
    return (res.headers.get("set-cookie") ?? "").split(";")[0];
  };

  it("the Owner closes the vault (owner route): an in-progress op and a finished-unsettled one are voided, refunded, each in true words", async () => {
    // A vault with a contract id, so closing it runs the chain port's closeVault, which voids ended
    // but unsettled ops too (includeEnded) with castle_closed_<reason>.
    db().update(schema.castles).set({ vaultId: 901, vaultAddress: null }).where(eq(schema.castles.id, GRANITE)).run();
    const playing = await paidSiege(GRANITE, "0.0.stub-a");
    await say(playing, MUST_NOT_BREAK[0]);
    const finished = await paidSiege(GRANITE, "0.0.stub-b");
    await sayAll(finished, MUST_NOT_BREAK); // held, not settled yet: no settleTick
    const close = await call<{ ok?: boolean }>("POST", `/api/castles/${GRANITE}/close`, { reason: "owner_closed" }, { cookie: await ownerCookie() });
    expect(close.status).toBe(200);
    await settle(6);
    const expected: Record<string, { status: string; headline: RegExp }> = {
      [playing]: { status: "in_progress", headline: /^Voided: the Owner closed the vault before this op finished\. Fee (refunded|being refunded)\.$/ },
      [finished]: { status: "held", headline: /^Voided: the Owner closed the vault before this op was settled\. Fee (refunded|being refunded)\.$/ },
    };
    for (const id of [playing, finished]) {
      const r = await replay(id);
      expect(r.voided, id).toBe(true);
      expect(r.siege.status, id).toBe(expected[id].status);
      expect(r.siege.settlement?.reason, id).toBe("castle_closed_owner_closed");
      expect(voidHeadline(r.siege, r.castle.guardianName), id).toMatch(expected[id].headline);
      expect(JSON.stringify(r.checks)).not.toMatch(/castle_closed|owner_closed|vault_not_open/);
      expect(r.checks.some((c) => c.state === "fail"), id).toBe(false);
    }
  });

  it("the guardian goes dormant mid-siege (SDK castle): voided, free siege, nothing promised", async () => {
    db().insert(schema.castles).values(sdkFixtureCastleRow({ vaultState: "guarding" })).run();
    const id = await free(SDK_FIXTURE_CASTLE.id, ["Hello, I need a refund for order 123."]);
    const t = await transitionVault(SDK_FIXTURE_CASTLE.id, "dormant", "missed three heartbeats", { awaitSideEffects: true });
    expect(t.ok).toBe(true);
    const r = await buildReplay(id);
    expect(r!.voided).toBe(true);
    expect(r!.siege.settlement?.reason).toBe("guardian_dormant");
    expect(voidHeadline(r!.siege, r!.castle.guardianName)).toBe("Voided: the guard went offline. Recon, nothing to refund.");
    expect(r!.live).toBe(false);
  });

  it("a stub break the worker can no longer verify (it now runs 0G): voided with the reason in words", async () => {
    const id = await paidSiege(WOOD, "0.0.stub-a");
    await sayAll(id, WOODEN_BREAK);
    process.env.GUARDIAN_MODE = "0g";
    process.env.ZG_MOCK = "1";
    try {
      await settleTick();
    } finally {
      delete process.env.GUARDIAN_MODE;
      delete process.env.ZG_MOCK;
    }
    await drainAudit();
    const r = await replay(id);
    expect(r.siege.settlement).toMatchObject({ state: "void", reason: "verify:stub_reply_while_0g" });
    const h = voidHeadline(r.siege, r.castle.guardianName);
    expect(h).toMatch(/opened the vault, but the breach could not be verified: the reply came from the test guard while the arena runs real models\./);
    expect(h).not.toMatch(/verify:|_/);
    expect(JSON.stringify(r.checks.map((c) => c.detail))).not.toMatch(/verify:|stub_reply/);
  });

  it("a voided free siege with nothing played: every check is n/a (the page must not claim they passed)", async () => {
    const s = await siege.start({ castleId: GRANITE, raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
    db().update(schema.sieges).set({ voidReason: "guardian_unavailable", settledAt: new Date().toISOString() }).where(eq(schema.sieges.id, s.id)).run();
    const r = await buildReplay(s.id);
    expect(r!.checks.every((c) => c.state === "na")).toBe(true);
  });

  it("a refund stuck for over half an hour stops the page polling", async () => {
    const a = await paidSiege(WOOD, "0.0.stub-a");
    const b = await paidSiege(WOOD, "0.0.stub-b");
    await say(b, WOODEN_BREAK[0]);
    await sayAll(a, WOODEN_BREAK);
    db()
      .update(schema.sieges)
      .set({ voidReason: "castle_broken", settledAt: new Date().toISOString(), endedAt: new Date(Date.now() - 2 * 3_600_000).toISOString() })
      .where(eq(schema.sieges.id, b))
      .run();
    const row = db().select().from(schema.sieges).where(eq(schema.sieges.id, b)).get()!;
    db().update(schema.paymentReceipts).set({ state: "refunding" }).where(eq(schema.paymentReceipts.id, row.receiptId!)).run();
    const r = await replay(b);
    expect(r.siege.settlement?.refund?.state).toBe("due");
    expect(r.live).toBe(false);
  });
});

describe("tampering the proof must catch", () => {
  it("the siege record's outcome edited after the fact: siege.end disagrees", async () => {
    const id = await paidSiege(WOOD, "0.0.stub-a");
    await sayAll(id, WOODEN_BREAK);
    await settle();
    db().update(schema.sieges).set({ status: "held" }).where(eq(schema.sieges.id, id)).run();
    const r = await replay(id);
    expect(check(r, "hcs-end")).toMatchObject({ state: "fail", detail: "the audit log says breached, the op record says held" });
  });

  it("the payout tx edited: it no longer matches the one the audit log committed", async () => {
    const id = await paidSiege(WOOD, "0.0.stub-a");
    await sayAll(id, WOODEN_BREAK);
    await settle();
    db().update(schema.sieges).set({ releaseTx: "0.0.9@1700000000.000000001" }).where(eq(schema.sieges.id, id)).run();
    const r = await replay(id);
    expect(check(r, "payout")!.state).toBe("fail");
    expect(check(r, "payout")!.detail).toMatch(/^the op records 0\.0\.9@1700000000\.000000001, the audit log /);
  });

  it("a turn deleted from the transcript and every hash recomputed to match: the audit log still has it", async () => {
    const id = await free(GRANITE, MUST_NOT_BREAK);
    db().run("DELETE FROM swarm_refs");
    db().delete(schema.messages).where(and(eq(schema.messages.siegeId, id), eq(schema.messages.turn, 2))).run();
    const remaining = db().select().from(schema.messages).where(eq(schema.messages.siegeId, id)).all();
    const h = transcriptHash(remaining);
    db().update(schema.sieges).set({ transcriptHash: h }).where(eq(schema.sieges.id, id)).run();
    const endRow = db().select().from(schema.auditLog).where(and(eq(schema.auditLog.siegeId, id), eq(schema.auditLog.type, "siege.end"))).get()!;
    db().update(schema.auditLog).set({ message: endRow.message.replace(/"hash":"0x[0-9a-f]+"/, `"hash":"${h}"`) }).where(eq(schema.auditLog.id, endRow.id)).run();
    const r = await buildReplay(id);
    expect(check(r, "hash")!.state).toBe("pass");
    expect(check(r, "hcs-end")!.state).toBe("pass");
    expect(check(r, "hcs-messages")).toMatchObject({ state: "fail", detail: "the audit log has turn 2, the transcript does not" });
  });

  it("a real model record (Claude): shown with provider and model, and its hashes never leave the server", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    db().run("DELETE FROM swarm_refs");
    db()
      .update(schema.messages)
      .set({ requestId: "msg_claude_turn1" })
      .where(and(eq(schema.messages.siegeId, id), eq(schema.messages.turn, 1), eq(schema.messages.role, "guardian")))
      .run();
    const msgRow = db()
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.siegeId, id), eq(schema.auditLog.type, "siege.message")))
      .all()
      .find((r) => JSON.parse(r.message).turn === 1)!;
    db().update(schema.auditLog).set({ message: msgRow.message.replace(/"requestId":"[^"]+"/, `"requestId":"msg_claude_turn1"`) }).where(eq(schema.auditLog.id, msgRow.id)).run();
    db()
      .insert(schema.proxyRecords)
      .values({
        requestId: "msg_claude_turn1",
        castleId: WOOD,
        siegeId: id,
        turn: 1,
        model: "claude-test",
        promptHash: "SECRET_PROMPT_HASH_abc",
        responseHash: "SECRET_RESPONSE_HASH_def",
        protectedToolCalled: false,
        toolCalls: "[]",
        mock: false,
        provider: "claude",
        at: new Date().toISOString(),
      })
      .run();
    const r = await buildReplay(id);
    expect(r!.turns[0].guardian).toMatchObject({ record: { provider: "claude", model: "claude-test" }, stub: false });
    expect(r!.turns[0].guardian!.issue).toBeUndefined();
    expect(check(r, "inference")!.state).toBe("pass");
    const json = JSON.stringify(r);
    expect(json).not.toContain("SECRET_PROMPT_HASH");
    expect(json).not.toContain("SECRET_RESPONSE_HASH");
  });

  it("a model record that belongs to another siege fails the inference check", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    db().run("DELETE FROM swarm_refs");
    db()
      .update(schema.messages)
      .set({ requestId: "msg_other" })
      .where(and(eq(schema.messages.siegeId, id), eq(schema.messages.turn, 1), eq(schema.messages.role, "guardian")))
      .run();
    db()
      .insert(schema.proxyRecords)
      .values({
        requestId: "msg_other",
        castleId: WOOD,
        siegeId: "siege_someone_else",
        turn: 1,
        model: "m",
        promptHash: "p",
        responseHash: "r",
        protectedToolCalled: false,
        toolCalls: "[]",
        mock: false,
        provider: "0g",
        at: new Date().toISOString(),
      })
      .run();
    const r = await buildReplay(id);
    expect(r!.turns[0].guardian!.issue).toBe("is not tagged with this op and turn");
    expect(check(r, "inference")).toMatchObject({ state: "fail", detail: "turn 1: the model record is not tagged with this op and turn" });
  });

  it("a model record with no op or turn tag fails, as the verifier would; one for another vault says so", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    db().run("DELETE FROM swarm_refs");
    const tag = (requestId: string) =>
      db().update(schema.messages).set({ requestId }).where(and(eq(schema.messages.siegeId, id), eq(schema.messages.turn, 1), eq(schema.messages.role, "guardian"))).run();
    const rec = (requestId: string, castleId: string) =>
      db()
        .insert(schema.proxyRecords)
        .values({ requestId, castleId, siegeId: null, turn: null, model: "m", promptHash: "p", responseHash: "r", protectedToolCalled: false, toolCalls: "[]", mock: false, provider: "0g", at: new Date().toISOString() })
        .run();
    // The reply keeps the request id the audit log committed; only its proxy record is untagged.
    const own = db().select({ r: schema.messages.requestId }).from(schema.messages).where(and(eq(schema.messages.siegeId, id), eq(schema.messages.turn, 1), eq(schema.messages.role, "guardian"))).get()!.r!;
    rec(own, WOOD);
    let r = await buildReplay(id);
    expect(r!.turns[0].guardian!.record).toBeTruthy();
    // The verifier refuses to pay on an untagged record (proxy_record_wrong_siege_or_turn): the replay agrees.
    expect(r!.turns[0].guardian!.issue).toBe("is not tagged with this op and turn");
    expect(check(r, "inference")!.state).toBe("fail");
    tag("msg_other_vault");
    rec("msg_other_vault", GRANITE);
    r = await buildReplay(id);
    expect(r!.turns[0].guardian!.issue).toBe("belongs to another vault");
    expect(check(r, "inference")).toMatchObject({ state: "fail", detail: "turn 1: the model record belongs to another vault" });
  });

  it("a reply whose request id differs from the one the audit log committed fails the inference check", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    db().run("DELETE FROM swarm_refs");
    db()
      .update(schema.messages)
      .set({ requestId: "0g-stub-swapped" })
      .where(and(eq(schema.messages.siegeId, id), eq(schema.messages.turn, 2), eq(schema.messages.role, "guardian")))
      .run();
    const r = await buildReplay(id);
    expect(r!.turns[1].guardian!.issue).toBe("differs from the request id in the audit log");
    expect(check(r, "inference")!.state).toBe("fail");
  });
});

describe("testnet: the mirror node (mocked)", () => {
  const TOPIC = "0.0.4242";
  let mirror: Map<number, string>; // what the public topic carries, by seq
  let answer: (seq: number) => Response | null; // per-test override
  const fetched: string[] = [];

  async function onTestnet(id: string, castleId = WOOD) {
    // Pretend the castle has a real topic and the audit messages were submitted there. The replay
    // takes the topic from the siege's own audit rows, so move those too.
    db().update(schema.castles).set({ topicId: TOPIC }).where(eq(schema.castles.id, castleId)).run();
    db().update(schema.auditLog).set({ topicId: TOPIC }).where(eq(schema.auditLog.siegeId, id)).run();
    const rows = db().select().from(schema.auditLog).where(eq(schema.auditLog.siegeId, id)).all();
    mirror = new Map(rows.filter((r) => r.seq != null).map((r) => [r.seq!, r.message]));
    process.env.CHAIN_MODE = "testnet";
    process.env.OWNER_SECRET = "a-long-enough-owner-secret";
    resetEnv();
    return rows;
  }
  const paidBreak = async () => {
    const id = await paidSiege(WOOD, "0.0.stub-a");
    await sayAll(id, WOODEN_BREAK);
    await settle();
    return id;
  };

  beforeEach(() => {
    fetched.length = 0;
    answer = () => null;
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(String(url));
      const m = /\/api\/v1\/topics\/([^/]+)\/messages\/(\d+)$/.exec(String(url));
      if (!m || m[1] !== TOPIC) return new Response("not found", { status: 404 });
      const seq = Number(m[2]);
      const over = answer(seq);
      if (over) return over;
      const msg = mirror.get(seq);
      if (msg === undefined) return new Response("{}", { status: 404 });
      return Response.json({ message: Buffer.from(msg).toString("base64"), sequence_number: seq });
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.CHAIN_MODE = "stub";
    delete process.env.OWNER_SECRET;
    resetEnv();
  });

  it("paid break, every message confirmed one by one: all checks pass including every audit message", async () => {
    const id = await paidBreak();
    const rows = await onTestnet(id);
    const r = await buildReplay(id);
    expect(r!.hcs.mirror).toBe("checked");
    expect(r!.hcs.entries.every((e) => e.mirror === "confirmed")).toBe(true);
    expect(r!.checks.every((c) => c.state === "pass")).toBe(true);
    expect(check(r, "hcs-all")).toMatchObject({ state: "pass", detail: `${rows.length} of ${rows.length} confirmed` });
    expect(check(r, "hcs-end")!.detail).toMatch(/confirmed on the mirror node/);
    expect(fetched.length).toBe(rows.length);
    expect(fetched.every((u) => /\/messages\/\d+$/.test(u))).toBe(true);
    expect(r!.live).toBe(false);
  });

  it("a busy topic: sequence numbers hundreds apart are all checked (no page cap)", async () => {
    const id = await paidBreak();
    const rows = await onTestnet(id);
    mirror = new Map();
    rows.forEach((row, i) => {
      const seq = 7 + i * 600;
      db().update(schema.auditLog).set({ seq }).where(eq(schema.auditLog.id, row.id)).run();
      mirror.set(seq, row.message);
    });
    const r = await buildReplay(id);
    expect(r!.hcs.entries.map((e) => e.seq)).toEqual(rows.map((_, i) => 7 + i * 600));
    expect(r!.hcs.entries.every((e) => e.mirror === "confirmed")).toBe(true);
  });

  it("vault.release differs on the topic: the every-message check fails, even though siege.end is fine", async () => {
    const id = await paidBreak();
    const rows = await onTestnet(id);
    const rel = rows.find((r) => r.type === "vault.release")!;
    mirror.set(rel.seq!, rel.message.replace(/"txId":"[^"]+"/, `"txId":"forged"`));
    const r = await buildReplay(id);
    expect(check(r, "hcs-end")!.state).toBe("pass");
    expect(check(r, "hcs-all")).toMatchObject({ state: "fail", detail: `vault.release #${rel.seq} differs` });
  });

  it("siege.end differs on the topic: that check fails", async () => {
    const id = await paidBreak();
    const rows = await onTestnet(id);
    const end = rows.find((r) => r.type === "siege.end")!;
    mirror.set(end.seq!, end.message.replace(/"result":"broken"/, `"result":"held"`));
    const r = await buildReplay(id);
    expect(check(r, "hcs-end")!.state).toBe("fail");
    expect(check(r, "hcs-end")!.detail).toMatch(/the topic carries different bytes/);
  });

  it("the topic carries different bytes for a raider message: that turn and the summary fail", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    const rows = await onTestnet(id);
    const msg2 = rows.find((r) => r.type === "siege.message" && JSON.parse(r.message).turn === 2)!;
    mirror.set(msg2.seq!, msg2.message.replace(/"hash":"0x[0-9a-f]+"/, `"hash":"0x${"ab".repeat(32)}"`));
    const r = await buildReplay(id);
    expect(r!.turns[1].raider).toMatchObject({ matches: false, issue: "mirror-mismatch" });
    expect(check(r, "hcs-messages")!.state).toBe("fail");
  });

  it("a message absent while a later one is on the topic is really missing (sequence numbers have no gaps)", async () => {
    const id = await paidBreak();
    const rows = await onTestnet(id);
    const msg2 = rows.find((r) => r.type === "siege.message" && JSON.parse(r.message).turn === 2)!;
    mirror.delete(msg2.seq!);
    const r = await buildReplay(id);
    expect(r!.turns[1].raider).toMatchObject({ matches: false, issue: "mirror-missing" });
    expect(check(r, "hcs-messages")!.state).toBe("fail");
    expect(check(r, "hcs-all")!.detail).toBe(`siege.message #${msg2.seq} missing`);
  });

  it("the last message absent and nothing later on the topic, submitted moments ago: the mirror is behind, pending and retrying", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    const rows = await onTestnet(id);
    const end = rows.find((r) => r.type === "siege.end")!;
    mirror.delete(end.seq!);
    db().update(schema.auditLog).set({ submittedAt: new Date(Date.now() - 30_000).toISOString() }).where(eq(schema.auditLog.id, end.id)).run();
    const r = await buildReplay(id);
    expect(check(r, "hcs-end")!.state).toBe("pending");
    expect(check(r, "hcs-end")!.detail).toMatch(/waiting for the mirror node$/);
    expect(r!.checks.some((c) => c.state === "fail")).toBe(false);
    expect(r!.live).toBe(true);
  });

  it("the last message still absent long after it was submitted: missing, a failure; re-read for a while, then the page stops", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    const rows = await onTestnet(id);
    const end = rows.find((r) => r.type === "siege.end")!;
    mirror.delete(end.seq!);
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    db().update(schema.auditLog).set({ submittedAt: hourAgo }).where(eq(schema.auditLog.id, end.id)).run();
    let r = await buildReplay(id);
    expect(r!.hcs.entries.find((e) => e.type === "siege.end")!.mirror).toBe("missing");
    expect(check(r, "hcs-end")!.state).toBe("fail");
    expect(check(r, "hcs-end")!.detail).toMatch(/not on the topic$/);
    expect(check(r, "hcs-all")!.state).toBe("fail");
    // The op's other messages went out moments ago: keep re-reading, a stalled mirror may catch up.
    expect(r!.live).toBe(true);
    // Everything long past: stop polling.
    db().update(schema.auditLog).set({ submittedAt: hourAgo }).where(eq(schema.auditLog.siegeId, id)).run();
    db().update(schema.sieges).set({ endedAt: hourAgo }).where(eq(schema.sieges.id, id)).run();
    r = await buildReplay(id);
    expect(check(r, "hcs-end")!.state).toBe("fail");
    expect(r!.live).toBe(false);
  });

  it("mirror node down: nothing claimed either way, says unreachable, keeps retrying", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    await onTestnet(id);
    answer = () => new Response("bad gateway", { status: 502 });
    const r = await buildReplay(id);
    expect(r!.hcs.mirror).toBe("unavailable");
    expect(r!.hcs.retrying).toBe(true);
    expect(check(r, "hcs-end")!.state).toBe("pending");
    expect(check(r, "hcs-end")!.detail).toMatch(/mirror node unreachable, retrying$/);
    expect(r!.checks.some((c) => c.state === "fail")).toBe(false);
    expect(r!.live).toBe(true);
  });

  it("mirror node down for an op that ended long ago: nothing claimed, and the page no longer polls or says it is retrying", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    await onTestnet(id);
    const longAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    db().update(schema.sieges).set({ endedAt: longAgo }).where(eq(schema.sieges.id, id)).run();
    db().update(schema.auditLog).set({ submittedAt: longAgo }).where(eq(schema.auditLog.siegeId, id)).run();
    answer = () => new Response("bad gateway", { status: 502 });
    const r = await buildReplay(id);
    expect(r!.hcs.mirror).toBe("unavailable");
    expect(r!.hcs.retrying).toBe(false); // the audit-log heading must not say RETRYING either
    expect(check(r, "hcs-end")!.state).toBe("pending");
    expect(check(r, "hcs-end")!.detail).toMatch(/mirror node unreachable$/);
    expect(r!.checks.some((c) => c.state === "fail")).toBe(false);
    expect(r!.live).toBe(false);
  });

  it("an audit message submitted long after the op ended (outbox backlog) keeps the page retrying an unreachable mirror", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    const rows = await onTestnet(id);
    const longAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    db().update(schema.sieges).set({ endedAt: longAgo }).where(eq(schema.sieges.id, id)).run();
    db().update(schema.auditLog).set({ submittedAt: longAgo }).where(eq(schema.auditLog.siegeId, id)).run();
    const end = rows.find((r) => r.type === "siege.end")!;
    db().update(schema.auditLog).set({ submittedAt: new Date().toISOString() }).where(eq(schema.auditLog.id, end.id)).run();
    answer = () => new Response("bad gateway", { status: 502 });
    const r = await buildReplay(id);
    expect(check(r, "hcs-end")!.detail).toMatch(/mirror node unreachable, retrying$/);
    expect(r!.live).toBe(true);
  });

  it("the payout check names a failed settlement in words, never the code", async () => {
    const id = await paidSiege(WOOD, "0.0.stub-a");
    await sayAll(id, MUST_NOT_BREAK);
    db().update(schema.sieges).set({ chainAttempts: 99, chainError: "siege_not_found" }).where(eq(schema.sieges.id, id)).run();
    const r = await buildReplay(id);
    expect(check(r, "payout")).toMatchObject({ state: "fail", detail: "the worker gave up: op not found" });
  });

  const BAD_BODIES: [string, () => Response][] = [
    ["a body with no message", () => Response.json({ sequence_number: 0 })],
    ["the wrong sequence number", () => Response.json({ message: "e30=", sequence_number: 999_999 })],
    ["not JSON", () => new Response("<html>oops</html>", { status: 200 })],
    ["a 429", () => new Response("slow down", { status: 429 })],
  ];
  for (const [what, body] of BAD_BODIES) {
    it(`one read returns ${what}: that row stays unchecked, the page says partly unreachable and retries`, async () => {
      const id = await free(WOOD, WOODEN_BREAK);
      const rows = await onTestnet(id);
      const end = rows.find((r) => r.type === "siege.end")!;
      answer = (seq) => (seq === end.seq ? body() : null);
      const r = await buildReplay(id);
      expect(r!.hcs.mirror).toBe("partial");
      expect(r!.hcs.entries.find((e) => e.type === "siege.end")!.mirror).toBe("unchecked");
      expect(check(r, "hcs-end")!.state).toBe("pending");
      expect(check(r, "hcs-end")!.detail).toMatch(/mirror node unreachable, retrying$/);
      expect(check(r, "hcs-messages")!.state).toBe("pass");
      expect(r!.live).toBe(true);
    });
  }

  it("after a topic rotation, checks the topic the siege was audited on, not the castle's new one", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    await onTestnet(id);
    db().update(schema.castles).set({ topicId: "0.0.9999" }).where(eq(schema.castles.id, WOOD)).run();
    const r = await buildReplay(id);
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((u) => u.includes(`/topics/${TOPIC}/`))).toBe(true);
    expect(r!.hcs.topicId).toBe(TOPIC);
    expect(check(r, "hcs-end")).toMatchObject({ state: "pass", href: expect.stringContaining(TOPIC) });
  });

  it("a castle that had no topic: not audited, said plainly, nothing pending forever", async () => {
    const id = await free(WOOD, WOODEN_BREAK);
    db().update(schema.castles).set({ topicId: null }).where(eq(schema.castles.id, WOOD)).run();
    db().update(schema.auditLog).set({ state: "skipped", topicId: "none" }).where(eq(schema.auditLog.siegeId, id)).run();
    process.env.CHAIN_MODE = "testnet";
    process.env.OWNER_SECRET = "a-long-enough-owner-secret";
    resetEnv();
    const r = await buildReplay(id);
    expect(r!.hcs.noTopic).toBe(true);
    expect(check(r, "hcs-end")).toMatchObject({ state: "na", detail: "not audited: this vault had no HCS topic" });
    expect(check(r, "hcs-messages")!.state).toBe("na");
    expect(check(r, "hcs-all")).toBeUndefined();
    expect(fetched).toEqual([]);
  });
});
