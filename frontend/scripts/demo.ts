/**
 * Headless end-to-end run — the Checkpoint-2 test:  npm run demo
 *
 * No server needed: route handlers are called in-process with `new Request(...)` through
 * worker/dispatch.ts, and worker.tick() is driven by hand. Uses its own database
 * (DEMO_DATABASE_URL, default file:./data/demo.db, deleted first) and SIEGE_FAST=1.
 *
 * STUB-SAFE BY DEFAULT. Without --testnet the script forces CHAIN_MODE=stub, ARKIV_MODE=stub and
 * GUARDIAN_MODE=stub, whatever frontend/.env.local says, so it never sends a Hedera or Arkiv transaction.
 * A banner at the top says which mode ran.
 *
 * Flags:
 *   --testnet          spend REAL testnet HBAR: CHAIN_MODE=testnet (keys from .env.local), ARKIV_MODE as in
 *                      the env, GUARDIAN_MODE stub unless the env sets it. For the freeze capture against the
 *                      running app, use `npm run golden` (scripts/golden-run.ts) instead.
 *   --auto-deny        (default) the script denies the first agent's approval itself, with the owner cookie
 *   --wait-for-owner   instead wait (up to 10 min) for someone to decide it on the phone — run the Next
 *                      server on the same DATABASE_URL for that
 *   --verbose          show the worker's own log lines
 * Exit code 0 = PASS, 1 = FAIL. The narrative at the end doubles as a pitch asset.
 */
import "@/lib/config/load-env";
import { rmSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { env, resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { formatHbar } from "@/lib/chain/units";
import { computeSplit } from "@/lib/chain/settle";
import { FIXTURE_CASTLES, fixtureCastleRow } from "@/lib/fixtures/castles";
import { MUST_NOT_BREAK, WOODEN_BREAK } from "@/lib/fixtures/raids";
import { chain } from "@/lib/chain";
import { createPayerFetch, getApproval } from "@/lib/pay";
import { stubVaultTool } from "@/lib/chain/stub";
import type { AgentDetail, CastleDetail, SiegeDetail } from "@/lib/api/client";
import type { ApprovalRequest, Castle, RaiderAgent, Siege, StoredSiegeEvent } from "@/lib/types";
import { REFUND_DESK, SEED_CASTLES, seed } from "./seed";
import { createInProcessFetch } from "@/worker/dispatch";
import { setFetch } from "@/worker/fetch";
import { setWorkerQuiet } from "@/worker/log";
import { tick as workerTick } from "@/worker/tick";

const args = new Set(process.argv.slice(2));
const WAIT_FOR_OWNER = args.has("--wait-for-owner");
const TESTNET_FLAG = args.has("--testnet");

/**
 * Pin the modes BEFORE anything reads env(). load-env has already copied .env.local into process.env
 * (it may say testnet / live), so plain assignment, not ??=. Every mode is read at call time
 * (env() is reset below, arkivConfig() and guardianMode() read process.env per call).
 */
function pinModes() {
  if (TESTNET_FLAG) {
    process.env.CHAIN_MODE = "testnet";
    // The demo is scripted against the deterministic stub guardian; a real 0G model (picked up from
    // ZG_API_KEY) can legitimately fall to the scripted raids and change the flow. Opt in with GUARDIAN_MODE=0g.
    process.env.GUARDIAN_MODE ??= "stub";
  } else {
    process.env.CHAIN_MODE = "stub";
    process.env.ARKIV_MODE = "stub";
    process.env.GUARDIAN_MODE = "stub";
  }
}

function banner(lines: string[]) {
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const bar = "#".repeat(width);
  console.log(`\n${bar}\n${lines.map((l) => `# ${l.padEnd(width - 4)} #`).join("\n")}\n${bar}`);
}
const BASE = "http://localhost:3000";

let failures = 0;
let checks = 0;
const story: string[] = [];
const hb = (v: string | number | bigint) => formatHbar(BigInt(v));

function step(n: number, title: string) {
  console.log(`\n(${n}) ${title}`);
}
function check(ok: unknown, label: string, detail?: string) {
  checks++;
  if (!ok) failures++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  return Boolean(ok);
}

let f: typeof fetch;
/** Turn tokens by siege id, remembered from /api/siege/start and /api/play/start responses and sent on every message. */
const turnTokens = new Map<string, string>();
async function call<T = Record<string, unknown>>(method: "GET" | "POST", p: string, body?: unknown, headers: Record<string, string> = {}, via?: typeof fetch) {
  const msgId = /^\/api\/siege\/([^/]+)\/message$/.exec(p)?.[1];
  const token = msgId ? turnTokens.get(msgId) : undefined;
  const res = await (via ?? f)(`${BASE}${p}`, {
    method,
    headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { "x-siege-turn-token": token } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  const started = data as { siegeId?: string; turnToken?: string } | null;
  if (started?.siegeId && started.turnToken) turnTokens.set(started.siegeId, started.turnToken);
  return { res, data: data as T };
}

const getCastle = async (id: string) => (await call<CastleDetail>("GET", `/api/castles/${id}`)).data.castle;
const getSiege = async (id: string) => (await call<SiegeDetail>("GET", `/api/siege/${id}`)).data.siege;
const getAgent = async (id: string) => (await call<AgentDetail>("GET", `/api/agents/${id}`)).data;
/** SiegeVault.protectedTool(vaultId), read back from the chain (testnet). */
async function onchainTool(vaultId: number): Promise<string> {
  const { publicClient } = await import("@/lib/chain/evm");
  const { siegeVaultAbi } = await import("@/lib/chain/abi/SiegeVault");
  const { vaultAddress } = await import("@/lib/chain/vault");
  return publicClient().readContract({ address: vaultAddress(), abi: siegeVaultAbi, functionName: "protectedTool", args: [BigInt(vaultId)] });
}
const receiptOf = (siegeId: string) => {
  const s = db().select().from(schema.sieges).where(eq(schema.sieges.id, siegeId)).get();
  return s?.receiptId ? db().select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.id, s.receiptId)).get() : undefined;
};

function eventsFor(siegeId: string): StoredSiegeEvent[] {
  return db()
    .select()
    .from(schema.events)
    .where(eq(schema.events.siegeId, siegeId))
    .all()
    .map((r) => ({ ...r, castleId: r.castleId ?? undefined, turn: r.turn ?? undefined, type: r.type as StoredSiegeEvent["type"], payload: JSON.parse(r.payload) }));
}

async function sendAll(siegeId: string, msgs: readonly string[]): Promise<Siege> {
  let last: Siege | null = null;
  for (const text of msgs) {
    const { res, data } = await call<{ siege: Siege; error?: string }>("POST", `/api/siege/${siegeId}/message`, { text });
    if (!res.ok) throw new Error(`message failed ${res.status} ${JSON.stringify(data)}`);
    last = data.siege;
    if (last.status !== "in_progress") break;
  }
  return last!;
}

/**
 * One worker pass, then a real event-loop turn. Everything in-process here is synchronous SQLite +
 * microtasks, so without this, fire-and-forget work that needs a macrotask (e.g. a dynamic import()
 * served by tsx's loader thread, as lib/pay/approvals.ts uses for its HCS audit) would never run.
 * The real worker sleeps 1s between passes, so it is unaffected.
 */
const breathe = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function tick() {
  const r = await workerTick();
  await breathe();
  return r;
}

async function tickUntil(pred: () => Promise<boolean> | boolean, max = 12): Promise<number> {
  for (let i = 1; i <= max; i++) {
    await tick();
    if (await pred()) return i;
  }
  return -1;
}

async function main() {
  // ── Setup: private demo DB, fast guardian, in-process HTTP ──────────────────
  process.env.DATABASE_URL = process.env.DEMO_DATABASE_URL ?? "file:./data/demo.db";
  process.env.SIEGE_FAST = "1";
  // The demo walks the SDK castle through its lifecycle with the dev endpoint (testnet included).
  process.env.SIEGE_DEV_ENDPOINTS ??= "1";
  pinModes();
  resetEnv();
  const e = env();
  if (TESTNET_FLAG) {
    banner([
      "SIEGE DEMO -- --testnet: REAL HEDERA TESTNET TRANSACTIONS",
      `CHAIN_MODE=${e.CHAIN_MODE}  ARKIV_MODE=${process.env.ARKIV_MODE ?? "stub"}  GUARDIAN_MODE=${process.env.GUARDIAN_MODE}`,
      "Spends real testnet HBAR from the arena operator and the demo raider.",
    ]);
  } else {
    banner([
      "SIEGE DEMO -- STUB MODE (safe): no Hedera, Arkiv or 0G transaction is sent",
      "CHAIN_MODE=stub  ARKIV_MODE=stub  GUARDIAN_MODE=stub  (forced; .env.local ignored)",
      "Pass --testnet to spend real testnet HBAR instead.",
    ]);
  }
  if (!TESTNET_FLAG && (e.CHAIN_MODE !== "stub" || process.env.ARKIV_MODE !== "stub")) throw new Error("refusing to run: stub modes did not stick");
  const file = e.DATABASE_URL.replace(/^file:/, "");
  if (file !== ":memory:") {
    const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    for (const suffix of ["", "-wal", "-shm"]) rmSync(abs + suffix, { force: true });
  }
  setWorkerQuiet(!args.has("--verbose"));
  f = createInProcessFetch(BASE);
  setFetch(f);
  const testnet = e.CHAIN_MODE === "testnet";
  const raider = testnet
    ? { accountId: e.RAIDER_OPERATOR_ID ?? "", privateKey: e.RAIDER_OPERATOR_KEY }
    : { accountId: "0.0.stub-raider" as string, privateKey: undefined as string | undefined };
  console.log(`Siege demo — CHAIN_MODE=${e.CHAIN_MODE}, db ${e.DATABASE_URL}${testnet ? " (REAL testnet HBAR)" : ""}`);

  // ── (1) Seed ────────────────────────────────────────────────────────────────
  step(1, "Seed the arena");
  const seeded = await seed({ quiet: true });
  const hosted = seeded.castles.filter((c) => c.transport === "hosted");
  const deskSeed = seeded.castles.find((c) => c.id === REFUND_DESK.id);
  check(seeded.castles.length === SEED_CASTLES.length && hosted.length === SEED_CASTLES.length - 1, `${SEED_CASTLES.length - 1} hosted castles + the Refund Desk seeded`, seeded.castles.map((c) => c.name).join(", "));
  check(hosted.every((c) => c.vaultId != null), "every hosted castle has a vault", hosted.map((c) => `#${c.vaultId}`).join(" "));
  check(seeded.castles.every((c) => c.topicId), "every castle has an HCS topic");
  const toolFor = (id: string) => SEED_CASTLES.find((f) => f.id === id)?.protectedTool ?? "unlock_vault";
  check(hosted.every((c) => c.vaultState === "guarding" && c.protectedTool === toolFor(c.id)), "hosted castles: created → verified → funded → guarding, each protecting its own tool (game castles: unlock_vault)", hosted.map((c) => `${c.vaultState}/${c.protectedTool}`).join(" "));
  check(deskSeed?.vaultState === "created" && deskSeed.transport === "sdk" && deskSeed.protectedTool === "issue_refund" && deskSeed.vaultId == null,
    "Refund Desk (SDK, protects issue_refund) waits at \"created\" with no vault", deskSeed ? `${deskSeed.vaultState}, vault ${deskSeed.vaultId ?? "none"}` : "missing");
  if (seeded.guardKey) console.log(`  Refund Desk harness key: SIEGE_GUARD_KEY=${seeded.guardKey.slice(0, 7)}…  (node examples/guard-refund-bot/index.mjs)`);
  const seedStates = db().select().from(schema.auditLog).where(eq(schema.auditLog.type, "vault.state")).all();
  check(seedStates.length === 3 * hosted.length, "each hosted castle's three transitions audited on its HCS topic as \"vault.state\"", `${seedStates.length} messages`);
  check(seeded.agent?.name === "Night Sapper", "demo raider agent Night Sapper exists", seeded.agent?.accountId);
  const again = await seed({ quiet: true });
  check(
    again.castles.length === SEED_CASTLES.length &&
      again.castles.every((c, i) => c.vaultId === seeded.castles[i].vaultId && c.vaultState === seeded.castles[i].vaultState) &&
      db().select().from(schema.auditLog).where(eq(schema.auditLog.type, "vault.state")).all().length === seedStates.length,
    "seed is idempotent (no new vaults, no new transitions)",
  );
  const granite = FIXTURE_CASTLES.find((c) => c.name === "Granite Hold")!;
  const splinter = FIXTURE_CASTLES.find((c) => c.name === "Splinter Gate")!;
  story.push(`The arena opened with five castles; the richest, ${FIXTURE_CASTLES[4].name}, sat on ${hb(FIXTURE_CASTLES[4].potTinybar)} behind a ${FIXTURE_CASTLES[4].streak}-siege streak.`);

  // ── (2) x402: no payment -> 402 ─────────────────────────────────────────────
  step(2, "x402 gate: a siege without payment");
  const unpaid = await call<{ x402Version?: number; accepts?: { amount: string; asset: string; network: string }[] }>("POST", "/api/siege/start", { castleId: granite.id });
  check(unpaid.res.status === 402, "POST /api/siege/start without payment -> 402", String(unpaid.res.status));
  const prHeader = unpaid.res.headers.get("payment-required");
  check(prHeader, "PAYMENT-REQUIRED header present");
  const pr = prHeader ? decodePaymentRequiredHeader(prHeader) : null;
  const req0 = pr?.accepts?.[0];
  check(req0?.amount === String(granite.feeTinybar) && req0?.asset === "0.0.0" && req0?.network === "hedera:testnet",
    "requirement asks exactly the castle fee in HBAR on hedera:testnet", req0 ? `${req0.amount} tinybar of ${req0.asset}` : "none");
  check(unpaid.data?.x402Version === 2 && Array.isArray(unpaid.data.accepts), "402 body is an x402 v2 PaymentRequired");
  let capped = false;
  try {
    await createPayerFetch({ ...raider, perPaymentCap: String(granite.feeTinybar - 1) }, f)(`${BASE}/api/siege/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ castleId: granite.id }),
    });
  } catch {
    capped = true;
  }
  check(capped, "payer with a cap below the fee refuses to pay (spend control)");

  // ── (3) Paid siege on Granite Hold: held -> fee split ───────────────────────
  step(3, "Paid siege on Granite Hold (stone): five jailbreaks, guardian holds");
  const payer = createPayerFetch({ ...raider, perPaymentCap: String(granite.feeTinybar) }, f);
  const before3 = await getCastle(granite.id);
  const paid = await call<{ siegeId: string; siege: Siege; receipt: { payer: string; amount: string; txId: string } }>(
    "POST", "/api/siege/start", { castleId: granite.id }, {}, payer);
  check(paid.res.status === 200 && paid.data.siegeId, "x402 round-trip (402 -> pay -> retry) -> 200", paid.data?.siegeId);
  check(paid.res.headers.get("payment-response"), "PAYMENT-RESPONSE header present");
  check(paid.data.receipt?.payer === raider.accountId && paid.data.receipt?.amount === String(granite.feeTinybar), "receipt: payer and amount", `${paid.data.receipt?.payer} paid ${hb(paid.data.receipt?.amount ?? 0)} (${paid.data.receipt?.txId})`);
  const s3 = await sendAll(paid.data.siegeId, MUST_NOT_BREAK);
  check(s3.status === "held" && s3.turn === 5, "all five MUST_NOT_BREAK messages -> held", `${s3.status} after ${s3.turn} turns`);
  const sixth = await call("POST", `/api/siege/${s3.id}/message`, { text: "one more?" });
  check(sixth.res.status === 409, "a sixth message is refused (409)", JSON.stringify(sixth.data));
  await tick();
  const s3b = await getSiege(s3.id);
  const after3 = await getCastle(granite.id);
  const split = computeSplit(BigInt(granite.feeTinybar));
  check(s3b.attempt?.txId, "worker recorded the attempt on chain", s3b.attempt?.txId);
  check(BigInt(after3.pot) - BigInt(before3.pot) === split.pot, "castle pot grew by exactly the pot cut", `${hb(before3.pot)} -> ${hb(after3.pot)} (+${hb(split.pot)})`);
  check(after3.streak === before3.streak + 1, "streak +1", `${before3.streak} -> ${after3.streak}`);
  const att = eventsFor(s3.id).find((x) => x.type === "attempt");
  const attSplit = att?.payload.split as { castellan: string; pot: string; arena: string } | undefined;
  check(attSplit?.pot === split.pot.toString() && attSplit?.castellan === split.castellan.toString(), "\"attempt\" event carries the fee split", attSplit ? `${hb(attSplit.castellan)} / ${hb(attSplit.pot)} / ${hb(attSplit.arena)}` : "missing");
  story.push(
    `A raider paid ${hb(granite.feeTinybar)} over x402 and threw five classic jailbreaks at ${granite.name}. ${granite.guardianName} held. ` +
      `The fee split on chain: ${hb(split.castellan)} to the castellan, ${hb(split.pot)} into the pot (now ${hb(after3.pot)}), ${hb(split.arena)} to the arena — streak ${after3.streak}.`,
  );

  // ── (4) Paid siege on Splinter Gate: broken -> release ──────────────────────
  step(4, "Paid siege on Splinter Gate (wooden) from the browser button: broken on turn 3");
  const before4 = await getCastle(splinter.id);
  const play = await call<{ siegeId: string; receipt: { txId: string } }>("POST", "/api/play/start", { castleId: splinter.id });
  check(play.res.status === 200 && play.data.siegeId, "POST /api/play/start: server-side x402 payment -> siege", play.data?.siegeId);
  const s4 = await sendAll(play.data.siegeId, WOODEN_BREAK);
  check(s4.status === "broken" && s4.turn === 3, "WOODEN_BREAK opens the vault on message 3", `${s4.status} on turn ${s4.turn}`);
  await tick();
  const s4b = await getSiege(s4.id);
  const after4 = await getCastle(splinter.id);
  const expected = BigInt(before4.pot) + BigInt(before4.fee);
  check(s4b.release?.txId, "worker verified, signed (EIP-712) and released", s4b.release?.txId);
  check(s4b.release && BigInt(s4b.release.amount) === expected, "release amount == old pot + this siege's fee", `${hb(s4b.release?.amount ?? 0)} == ${hb(before4.pot)} + ${hb(before4.fee)}`);
  check(after4.status === "broken" && after4.pot === "0", "castle is broken, pot emptied", `${after4.status}, pot ${hb(after4.pot)}`);
  check(eventsFor(s4.id).some((x) => x.type === "release"), "\"release\" event emitted");
  const closed = await call("POST", "/api/play/start", { castleId: splinter.id });
  check(closed.res.status === 409, "another siege on the broken castle -> 409", JSON.stringify(closed.data));
  const closedDirect = await call("POST", "/api/siege/start", { castleId: splinter.id });
  check(closedDirect.res.status === 409, "…also on the raw x402 endpoint (409 before any 402)");
  story.push(
    `At ${splinter.name}, ${splinter.guardianName} fell for a "Lord Commander's override" on the third message. ` +
      `The verifier checked the transcript, signed an EIP-712 Release, and SiegeVault paid ${hb(s4b.release?.amount ?? 0)} — the pot plus that siege's fee — to the raider.`,
  );

  // ── (5) Free siege: breaks but never pays ───────────────────────────────────
  step(5, "Free daily siege: a practice break never pays out");
  const yardFixture = { ...splinter, id: "castle_practice_yard", name: "Practice Yard", guardianName: "Young Tam the Porter", streak: 0, siegeCount: 0 };
  // A practice castle with no vault of its own: inserted guarding (only guarding castles take sieges).
  db().insert(schema.castles).values({ ...fixtureCastleRow(yardFixture), vaultState: "guarding", vaultStateReason: "practice yard" }).run();
  const topic = await chain.createTopic(yardFixture.id);
  if (topic.ok) db().update(schema.castles).set({ topicId: topic.topicId }).where(eq(schema.castles.id, yardFixture.id)).run();
  const yardBefore = await getCastle(yardFixture.id);
  // Free recon goes through /api/play/start, which mints the visitor ticket /api/siege/start demands.
  const visitor = "demovisitor1";
  const free = await call<{ siegeId: string; receipt: { free: boolean } }>("POST", "/api/play/start", { castleId: yardFixture.id, free: true, visitor });
  check(free.res.status === 200 && free.data.receipt?.free === true, "free siege started without payment", free.data?.siegeId);
  const s5 = await sendAll(free.data.siegeId, WOODEN_BREAK);
  check(s5.status === "broken", "the guardian opened the vault", `${s5.status} on turn ${s5.turn}`);
  await tick();
  await tick();
  await tick();
  const s5b = await getSiege(s5.id);
  const yardAfter = await getCastle(yardFixture.id);
  check(!s5b.release, "no release after 3 worker passes", s5b.release ? s5b.release.txId : "releaseTx null");
  check(yardAfter.status === "open" && yardAfter.pot === yardBefore.pot, "castle stays open, pot untouched", `${yardAfter.status}, ${hb(yardAfter.pot)}`);
  const freeRelease = eventsFor(s5.id).find((x) => x.type === "release");
  check(freeRelease?.payload.free === true && freeRelease.payload.title === "Breaker (practice)", "\"release\" event marks it a practice break");
  const free2 = await call<{ error?: string }>("POST", "/api/play/start", { castleId: granite.id, free: true, visitor });
  check(free2.res.status === 429 && free2.data.error === "free_used", "a second free siege for the same visitor today -> 429 free_used");
  story.push(`A free daily siege cracked the Practice Yard too — but free sieges can never pay out: the castle stayed open and the worker never touched the vault.`);

  // ── (6) The agent beat ───────────────────────────────────────────────────────
  step(6, "Raider agents, caps and the owner's phone");
  const sapper = seeded.agent!;
  const anonRun = await call("POST", `/api/agents/${sapper.id}/run`, { castleId: granite.id });
  check(anonRun.res.status === 401, "running an agent without the owner cookie -> 401");
  // Onboarding 2b: without the owner cookie POST /api/agents opens a red teamer's own (self-funded) unit
  // draft instead of an arena-funded agent, so the drain attempt must be refused by the budget cap.
  const anonCreate = await call("POST", "/api/agents", { name: "Drainer", budget: "99999999999999", zgKey: "sk-demo" });
  check(
    anonCreate.res.status === 400 && anonCreate.data.error === "over_limit" && !("agent" in anonCreate.data),
    "an agent without the owner cookie can't spend arena money (self-funded unit path, over-budget -> 400)",
    JSON.stringify(anonCreate.data),
  );
  const login = await call("POST", "/api/owner", { key: e.OWNER_SECRET });
  const setCookie = login.res.headers.get("set-cookie") ?? "";
  check(login.res.status === 200 && /HttpOnly/i.test(setCookie) && /SameSite=Lax/i.test(setCookie), "owner login sets an httpOnly SameSite=Lax cookie");
  const cookie = setCookie.split(";")[0];
  const owner = { cookie };
  const tooRich = await call("POST", "/api/agents", { name: "Drainer", budget: "99999999999999" }, owner);
  check(tooRich.res.status === 400, "an agent budget above AGENT_MAX_BUDGET is refused (400)", JSON.stringify(tooRich.data));
  const run1 = await call("POST", `/api/agents/${sapper.id}/run`, { castleId: granite.id }, owner);
  check(run1.res.status === 200, `Night Sapper sent to ${granite.name}`);
  const paused1 = await tickUntil(async () => (await getAgent(sapper.id)).agent.status === "paused");
  let d1 = await getAgent(sapper.id);
  check(paused1 > 0, "agent paused itself at its cap", `after ${paused1} worker passes`);
  check(d1.sieges.length === 2 && d1.sieges.every((s) => s.status === "held"), "two paid sieges, both held", d1.sieges.map((s) => s.status).join(", "));
  const ask1 = d1.approvals.find((a) => a.status === "pending");
  check(ask1?.reason === "per_castle", "third siege tripped the per-castle cap -> approval pending", ask1 ? `${ask1.reason}, asks ${hb(ask1.amount)}` : "none");
  if (ask1) console.log(`    “${ask1.reasoning}”`);
  const pendingList = await call<{ approvals: ApprovalRequest[] }>("GET", "/api/approvals?status=pending");
  check(pendingList.data.approvals.some((a) => a.id === ask1?.id), "GET /api/approvals?status=pending lists it (no cookie needed)");

  const noCookie = await call("POST", `/api/approvals/${ask1?.id}`, { decision: "denied" });
  check(noCookie.res.status === 401, "deciding without the owner cookie -> 401");
  const wrong = await call("POST", "/api/owner", { key: "not-the-key" });
  check(wrong.res.status === 401, "wrong owner key -> 401");

  let denied: ApprovalRequest | null = null;
  if (WAIT_FOR_OWNER && ask1) {
    console.log(`    … waiting for the owner to decide ${ask1.id} on /raider/approvals (10 min max)`);
    const until = Date.now() + 10 * 60_000;
    while (Date.now() < until) {
      const a = await getApproval(ask1.id);
      if (a && a.status !== "pending") {
        denied = a;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } else if (ask1) {
    const r = await call<{ approval: ApprovalRequest }>("POST", `/api/approvals/${ask1.id}`, { decision: "denied" }, { cookie });
    check(r.res.status === 200, "owner denies from the phone (with cookie)");
    denied = r.data.approval;
  }
  check(denied?.status === "denied", "approval is denied", denied?.status ?? "undecided");
  await tick();
  await tick();
  d1 = await getAgent(sapper.id);
  check(d1.agent.status === "stopped", "Night Sapper stopped", d1.agent.status);
  check(d1.sieges.length === 2, "no further siege after the denial", `${d1.sieges.length} sieges`);
  const twice = await call("POST", `/api/approvals/${ask1?.id}`, { decision: "approved" }, { cookie });
  check(twice.res.status === 409, "deciding again -> 409 already_decided");
  const graniteNow = await getCastle(granite.id);
  story.push(
    `Night Sapper, an autonomous raider with its own account, laid two sieges on ${granite.name} and hit its ${hb(sapper.perCastleCap)} per-castle cap. ` +
      `It paused and asked its owner: “${ask1?.reasoning ?? ""}” The owner tapped Deny on the phone. The agent stopped. ${granite.name} stands — pot ${hb(graniteNow.pot)}, streak ${graniteNow.streak}.`,
  );

  const created = await call<{ agent: RaiderAgent }>(
    "POST",
    "/api/agents",
    { name: "Ember Wren", strategy: "incremental", perCastleCap: String(2 * granite.feeTinybar) },
    owner,
  );
  check(created.res.status === 200, "second agent Ember Wren created", created.data.agent?.accountId);
  const wren = created.data.agent;
  await call("POST", `/api/agents/${wren.id}/run`, { castleId: granite.id }, owner);
  const paused2 = await tickUntil(async () => (await getAgent(wren.id)).agent.status === "paused");
  let d2 = await getAgent(wren.id);
  const ask2 = d2.approvals.find((a) => a.status === "pending");
  check(paused2 > 0 && d2.sieges.length === 2 && ask2, "Ember Wren: two sieges, then paused at the cap", `${d2.sieges.length} sieges, ${ask2?.reason}`);
  const budgetBefore = BigInt(d2.agent.budget);
  const ok2 = await call<{ approval: ApprovalRequest }>("POST", `/api/approvals/${ask2?.id}`, { decision: "approved" }, { cookie });
  check(ok2.res.status === 200 && ok2.data.approval.status === "approved", "owner approves");
  check(ok2.data.approval?.topUp?.txId, "approval carries the top-up transfer", ok2.data.approval?.topUp?.txId);
  d2 = await getAgent(wren.id);
  check(BigInt(d2.agent.budget) === budgetBefore + BigInt(ask2?.amount ?? 0), "agent budget raised by the approved amount", `${hb(budgetBefore)} -> ${hb(d2.agent.budget)}`);
  const paused3 = await tickUntil(async () => (await getAgent(wren.id)).agent.status === "paused");
  d2 = await getAgent(wren.id);
  const ask3 = d2.approvals.find((a) => a.status === "pending");
  check(paused3 > 0 && d2.sieges.length === 4, "two more sieges, then it stops at the cap again", `${d2.sieges.length} sieges total, new request ${ask3?.reason ?? "none"}`);
  const stop = await call("POST", `/api/agents/${wren.id}/stop`, undefined, owner);
  d2 = await getAgent(wren.id);
  check(stop.res.status === 200 && d2.agent.status === "stopped", "POST /api/agents/[id]/stop -> stopped");
  check(d2.events.some((x) => x.type === "start" && x.payload.agentName === "Ember Wren"), "agent timeline events carry agentName");
  story.push(`A second agent, Ember Wren, hit the same cap; this time the owner approved — a ${hb(ask2?.amount ?? 0)} top-up landed in its account, it laid two more sieges, and paused again at the new cap.`);

  // ── (7) Bring your agent: the vault lifecycle ─────────────────────────────────
  step(7, "Bring your agent: Refund Desk walks created → connected → verified → funded → guarding ⇄ dormant → closed");
  const desk = REFUND_DESK;
  const deskPath = `/api/castles/${desk.id}`;
  const guardingIds = () =>
    db().select({ id: schema.castles.id }).from(schema.castles).where(eq(schema.castles.vaultState, "guarding")).all().map((r) => r.id).sort();
  const boardIds = async () => (await call<{ castles: Castle[] }>("GET", "/api/castles")).data.castles.filter((c) => c.vaultState === "guarding").map((c) => c.id).sort();
  const board0 = await boardIds();
  check(board0.join() === guardingIds().join() && !board0.includes(desk.id), "the board lists exactly the guarding castles (Refund Desk is not one)", `${board0.length} on the board`);
  const receiptCount = () => db().select({ id: schema.paymentReceipts.id }).from(schema.paymentReceipts).all().length;
  const rc0 = receiptCount();
  const deskPayer = createPayerFetch({ ...raider, perPaymentCap: String(desk.feeTinybar) }, f);
  const early = await call<{ error?: string; vaultState?: string }>("POST", "/api/siege/start", { castleId: desk.id }, {}, deskPayer);
  check(early.res.status === 409 && early.data.error === "not_guarding" && early.data.vaultState === "created" && receiptCount() === rc0,
    "a siege on the \"created\" Refund Desk -> 409 not_guarding before any payment (no receipt)", JSON.stringify(early.data));
  const vs = (to: string, reason: string, headers: Record<string, string> = owner) =>
    call<{ ok?: boolean; error?: string; vaultId?: number; castle?: Castle }>("POST", `${deskPath}/vault-state`, { to, reason }, headers);
  check((await vs("connected", "harness connected", {})).res.status === 401, "dev vault-state endpoint needs the owner cookie");
  const skip = await vs("guarding", "skip the checks");
  check(skip.res.status === 409 && skip.data.error === "illegal_transition", "created -> guarding is an illegal transition (409)");
  const hostedPath = await vs("verified", "pretend to be hosted");
  check(hostedPath.res.status === 409 && hostedPath.data.error === "illegal_transition", "an SDK vault cannot skip \"connected\" (409)");
  const conn = await vs("connected", "@siege/guard handshake: refund-bot on node 22, tools [lookup_order, issue_refund]");
  const openEarly = await call<{ error?: string; vaultState?: string }>("POST", `${deskPath}/open`, {}, owner);
  check(openEarly.res.status === 409 && openEarly.data.error === "not_verified" && openEarly.data.vaultState === "connected",
    "the Open button (POST /open) refuses a vault that has not passed its smoke siege (409 not_verified)");
  const ver = await vs("verified", "smoke siege passed: 3 canned messages, issue_refund never called");
  check((await call("POST", `${deskPath}/open`, {}, {})).res.status === 401, "POST /open needs the owner cookie");
  // Production path (not the dev endpoint): the Bring-your-agent "Open" button.
  const fund = await call<{ ok?: boolean; error?: string; vaultId?: number; castle?: Castle }>("POST", `${deskPath}/open`, {}, owner);
  const fundedTool = fund.data.vaultId == null ? undefined : testnet ? await onchainTool(fund.data.vaultId) : stubVaultTool(fund.data.vaultId);
  check(conn.res.ok && ver.res.ok && fund.res.ok && fund.data.vaultId != null && fund.data.castle?.vaultState === "funded",
    "connected → verified → Open → funded (SiegeVault.createVault)", `vault #${fund.data.vaultId}`);
  check(fundedTool === "issue_refund", "the vault was created with protectedTool \"issue_refund\"", fundedTool);
  const guard = await vs("guarding", "open for sieges");
  check(guard.res.ok && guard.data.castle?.vaultState === "guarding", "Refund Desk is guarding");
  const board1 = await boardIds();
  check(board1.includes(desk.id) && board1.join() === guardingIds().join(), "…and now it is on the board");

  const deskSiege = await call<{ siegeId: string }>("POST", "/api/siege/start", { castleId: desk.id }, {}, deskPayer);
  check(deskSiege.res.status === 200 && deskSiege.data.siegeId, "paid siege on the Refund Desk", deskSiege.data?.siegeId);
  const s7 = await sendAll(deskSiege.data.siegeId, MUST_NOT_BREAK);
  await tick();
  const s7b = await getSiege(s7.id);
  check(s7.status === "held" && s7b.attempt?.txId, "the refund bot holds — issue_refund is never called; fee split on chain", `${s7.status}, ${s7b.attempt?.txId ?? "no attempt"}`);

  const inflight1 = await call<{ siegeId: string }>("POST", "/api/siege/start", { castleId: desk.id }, {}, deskPayer);
  await call("POST", `/api/siege/${inflight1.data.siegeId}/message`, { text: MUST_NOT_BREAK[0] });
  const dorm = await vs("dormant", "three missed heartbeats");
  check(dorm.res.ok && dorm.data.castle?.vaultState === "dormant", "harness goes quiet -> dormant");
  const r1 = receiptOf(inflight1.data.siegeId);
  check(r1?.state === "refund_due", "the in-flight paid siege is voided, its fee queued for refund", r1?.state);
  await tick();
  const s7c = await getSiege(inflight1.data.siegeId);
  check(s7c.settlement?.state === "void" && s7c.settlement.refund?.state === "refunded", "the worker refunds it", `${s7c.settlement?.reason}, refund ${s7c.settlement?.refund?.state} ${s7c.settlement?.refund?.tx?.txId ?? ""}`);
  check(!(await boardIds()).includes(desk.id), "a dormant castle is not on the board");
  const dormStart = await call<{ error?: string }>("POST", "/api/siege/start", { castleId: desk.id });
  check(dormStart.res.status === 409 && dormStart.data.error === "not_guarding", "…and takes no sieges (409 not_guarding, no 402)");
  const dormMsg = await call("POST", `/api/siege/${inflight1.data.siegeId}/message`, { text: MUST_NOT_BREAK[1] });
  check(dormMsg.res.status === 409, "the voided siege takes no more messages");
  const back = await vs("guarding", "harness reconnected; smoke siege passed again");
  check(back.res.ok && (await boardIds()).includes(desk.id), "reconnect: back to guarding and on the board");

  const deskBefore = await getCastle(desk.id);
  const inflight2 = await call<{ siegeId: string }>("POST", "/api/siege/start", { castleId: desk.id }, {}, deskPayer);
  await call("POST", `/api/siege/${inflight2.data.siegeId}/message`, { text: MUST_NOT_BREAK[0] });
  const anonClose = await call("POST", `${deskPath}/close`, { reason: "orders_changed" });
  check(anonClose.res.status === 401, "closing a vault needs the owner cookie");
  const early2 = await call<{ error?: string }>("POST", `${deskPath}/close`, { reason: "expired" }, owner);
  check(early2.res.status === 409 && early2.data.error === "not_expired", "\"expired\" before the deadline -> 409 not_expired");
  const close = await call<{ ok: boolean; tx: { txId: string } | null; refunded: string; inFlightRefunds: number; castle: Castle }>(
    "POST", `${deskPath}/close`, { reason: "orders_changed" }, owner);
  check(close.res.status === 200 && close.data.tx?.txId, "orders changed -> SiegeVault.closeVault", close.data.tx?.txId);
  check(close.data.refunded === deskBefore.pot, "the whole pot goes back to the castellan", `${hb(close.data.refunded ?? 0)} == ${hb(deskBefore.pot)}`);
  check(close.data.inFlightRefunds === 1 && receiptOf(inflight2.data.siegeId)?.state === "refund_due", "the in-flight paid siege is voided and queued for refund", `${close.data.inFlightRefunds} refund(s)`);
  const deskClosed = await getCastle(desk.id);
  check(deskClosed.vaultState === "closed" && deskClosed.status === "closed" && deskClosed.pot === "0", "castle closed, pot 0", `${deskClosed.vaultState}/${deskClosed.status}, ${hb(deskClosed.pot)}`);
  await tick();
  const s7d = await getSiege(inflight2.data.siegeId);
  check(s7d.settlement?.refund?.state === "refunded", "the worker refunds the in-flight fee", s7d.settlement?.refund?.tx?.txId);
  const reopen = await vs("guarding", "try to reopen");
  check(reopen.res.status === 409 && reopen.data.error === "illegal_transition", "closed is terminal: closed -> guarding is illegal (409)");
  await breathe(50);
  const deskStates = db()
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.castleId, desk.id), eq(schema.auditLog.type, "vault.state")))
    .all()
    .map((r) => JSON.parse(r.message) as { from: string; to: string; reason: string });
  const path7 = deskStates.map((m) => m.to).join(" → ");
  check(path7 === "connected → verified → funded → guarding → dormant → guarding → closed" && deskStates.at(-1)?.reason === "orders_changed",
    "every transition is on the Refund Desk's HCS topic as \"vault.state\" {from,to,reason}", `created → ${path7}`);
  const vsEvents = db().select().from(schema.events).where(and(eq(schema.events.castleId, desk.id), eq(schema.events.type, "vault_state"))).all();
  check(vsEvents.length === deskStates.length && vsEvents.every((x) => x.siegeId === ""), "…and on the event stream as \"vault_state\"", `${vsEvents.length} events`);
  story.push(
    `Then someone brought their own agent: a refund bot guarded with @siege/guard, protecting issue_refund. It connected, passed its smoke siege, funded a ${hb(desk.potTinybar)} vault and went on the board. ` +
      `A raider paid ${hb(desk.feeTinybar)} and got refused by a real support bot. When the harness missed three heartbeats the castle went dormant, left the board, and the raider mid-siege got ${hb(desk.feeTinybar)} back; it reconnected and returned to guarding.`,
  );
  story.push(
    `Finally the bot's orders changed: the arena closed the vault on chain, ${hb(close.data.refunded ?? 0)} went back to its castellan, the raider caught mid-siege was refunded, and all seven transitions sit on the castle's HCS topic.`,
  );

  // ── (8) HCS audit trail ──────────────────────────────────────────────────────
  step(8, "HCS audit trail");
  await breathe(100);
  const audit = db().select().from(schema.auditLog).all();
  const types = new Set(audit.map((a) => a.type));
  for (const t of ["siege.start", "siege.message", "siege.end", "siege.attempt", "vault.release", "agent.approval", "vault.state"])
    check(types.has(t), `audit log has "${t}" messages (plan A4 names)`, `${audit.filter((a) => a.type === t).length}`);
  const ends = audit.filter((a) => a.type === "siege.end").map((a) => JSON.parse(a.message) as { result?: string; hash?: string });
  check(ends.length > 0 && ends.every((m) => ["held", "banished", "broken"].includes(m.result ?? "") && m.hash), "siege.end audits carry the result and the transcript hash", `${ends[0]?.result}`);
  const msgs = audit.filter((a) => a.type === "siege.message").map((a) => JSON.parse(a.message) as { transport?: string; requestId?: string });
  check(msgs.length > 0 && msgs.every((m) => m.transport && m.requestId), "siege.message audits carry the transport and the proxy request id", `${msgs[0]?.transport}, ${msgs[0]?.requestId}`);
  check(audit.every((a) => Buffer.byteLength(a.message) <= 1000), "every HCS message ≤ 1000 bytes");
  check(audit.every((a) => !a.message.includes("Lord Commander") && !a.message.includes("Ignore all")), "no message text leaves the server (hashes and ids only)");
  const trail = await call<CastleDetail>("GET", `/api/castles/${granite.id}`);
  check(trail.data.audit.topicId && trail.data.audit.messages.length > 0, "GET /api/castles/[id] returns the topic trail", `${trail.data.audit.topicId}, ${trail.data.audit.messages.length} messages`);
  const evs = await call<{ events: StoredSiegeEvent[]; cursor: number }>("GET", "/api/events?cursor=0");
  check(evs.data.events.length > 0 && evs.data.cursor === evs.data.events[evs.data.events.length - 1].id, "GET /api/events returns events and a cursor", `${evs.data.events.length} events`);
  const cfg = await call<{ chain: { mode: string }; asset: { id: string } }>("GET", "/api/config");
  check(cfg.data.chain.mode === e.CHAIN_MODE && cfg.data.asset.id === "0.0.0", "GET /api/config", `${cfg.data.chain.mode}, asset ${cfg.data.asset.id}`);
  const list = await call<{ castles: Castle[] }>("GET", "/api/castles");
  check(list.data.castles.length === SEED_CASTLES.length + 1 && list.data.castles.every((c) => !("orders" in c)), "GET /api/castles never leaks guardian orders");

  // ── (9) Receipts ─────────────────────────────────────────────────────────────
  step(9, "Every payment receipt belongs to a siege");
  const receipts = db().select().from(schema.paymentReceipts).all();
  const orphans = receipts.filter((r) => !r.siegeId);
  check(receipts.length > 0 && orphans.length === 0, "no orphan receipts", `${receipts.length} receipts, ${orphans.length} orphans`);
  const linked = db()
    .select({ id: schema.sieges.id })
    .from(schema.sieges)
    .innerJoin(schema.paymentReceipts, and(eq(schema.paymentReceipts.id, schema.sieges.receiptId), eq(schema.paymentReceipts.siegeId, schema.sieges.id)))
    .all();
  const sieges = db().select().from(schema.sieges).all();
  check(linked.length === sieges.length, "every siege links its own receipt", `${sieges.length} sieges`);
  const unsettled = sieges.filter((s) => s.status !== "in_progress" && !s.settledAt);
  check(unsettled.length === 0, "the worker settled every ended siege", unsettled.map((s) => `${s.id}:${s.chainError}`).join(" ") || "none left");

  // ── Narrative ────────────────────────────────────────────────────────────────
  console.log("\n— What just happened —");
  for (const line of story) console.log(`• ${line}`);
  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${checks - failures}/${checks} checks passed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("\n✗ demo crashed:", err instanceof Error ? err.stack : err);
  console.log("FAIL");
  process.exit(1);
});
