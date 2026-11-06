/**
 * Golden run — the freeze-time capture for the submission:  npm run golden -- --yes [--agent]
 *
 * Drives the demo path against the RUNNING app over HTTP (never in-process), then writes every id and
 * HashScan link it produced to docs/golden-run.md. Run it once, at the freeze, with `npm run dev` and
 * `npm run worker` up on testnet.
 *
 *   (a) GET /api/config (must say chain.mode "testnet"), the SiegeVault address and its Sourcify status,
 *       and the unpaid POST /api/siege/start 402 challenge
 *   (b) a paid HOLD: POST /api/siege/start on a stone castle, paid over x402 from the script's own
 *       operator account (the demo raider, RAIDER_OPERATOR_ID/KEY), + the five MUST_NOT_BREAK messages,
 *       then poll GET /api/siege/[id] until the worker's recordAttempt lands
 *   (c) a paid BREAK: the same on the wooden castle with WOODEN_BREAK, poll until release lands
 *   (d) --agent: owner cookie, run Night Sapper on a stone castle, approve its first cap request
 *       (on-chain top-up), deny the second; the agent stops
 *   (e) wait for each castle's HCS outbox to drain (the worker submits audit rows in order, one receipt
 *       at a time), then the castles' HCS messages from the mirror node, the board's Arkiv read
 *   (f) docs/golden-run.md: a timestamped table (step, what happened, link) plus the raw ids
 *
 * Flags:
 *   --yes                 actually spend (without it: print the plan and what it costs, then exit)
 *   --agent               also run step (d)
 *   --url <url>           the app (default APP_URL, else http://localhost:3000)
 *   --agent-castle <id>   castle for step (d) (default: a guarding stone castle other than the hold's)
 *   --require-0g          refuse unless GET /api/config says the guardian is 0G (not the stub)
 *   --out <path>          report path (default ../docs/golden-run.md)
 *
 * Every paid op is paid from the operator's own account: this script's account is the demo raider
 * (RAIDER_OPERATOR_ID/KEY, read from its own env), and it pays exactly like an outside agent (J5) does,
 * with its own x402 client against /api/siege/start. POST /api/play/start no longer pays for an op
 * with no unit on testnet (DEMO_WALLET_OPS off).
 * Spends REAL testnet HBAR: the demo raider pays the two siege fees, the agent pays from its own
 * account, the treasury sends the top-up. Every step aborts the run cleanly on failure; nothing is
 * written then (the partial log with the links so far is printed), so a good docs/golden-run.md is
 * never replaced by a broken one. Re-running is safe: it lays new sieges, and it refuses before
 * spending anything if the wooden castle is already broken.
 *
 * The owner key comes from OWNER_SECRET (frontend/.env.local) and is never printed.
 */
import "@/lib/config/load-env";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MUST_NOT_BREAK, WOODEN_BREAK } from "@/lib/fixtures/raids";
import { formatHbar } from "@/lib/chain/units";
import { createPayerFetch } from "@/lib/pay/client";
import { accountUrl, contractUrl, isStubRef, topicUrl, txUrl } from "@/lib/chain/hashscan";
import type { AgentDetail, ArkivReadMeta, CastleDetail, ConfigResponse, SiegeDetail } from "@/lib/api/client";
import type { ApprovalRequest, Castle, RaiderAgent, Siege } from "@/lib/types";

// ── Arguments ───────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const YES = flag("--yes");
const WITH_AGENT = flag("--agent");
/** Hidden: lets the script run against a stub server, to test it. Writes docs/golden-run.sample.md. */
const ALLOW_STUB = flag("--allow-stub");
const REQUIRE_0G = flag("--require-0g");
const APP = (opt("--url") ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const DOCS = path.resolve(__dirname, "..", "..", "docs");
const OUT = path.resolve(opt("--out") ?? path.join(DOCS, ALLOW_STUB ? "golden-run.sample.md" : "golden-run.md"));
const MIRROR = (process.env.HEDERA_MIRROR_URL ?? "https://testnet.mirrornode.hedera.com").replace(/\/$/, "");
const SOURCIFY = "https://sourcify.dev/server/v2/contract/296";

const SETTLE_TIMEOUT_MS = 6 * 60_000;
const APPROVAL_TIMEOUT_MS = 20 * 60_000;
const POLL_MS = ALLOW_STUB ? 1_000 : 3_000;

// ── Report rows ─────────────────────────────────────────────────────────────

type Link = { label: string; url: string };
type Row = { step: string; at: string; what: string; links: Link[] };
const rows: Row[] = [];
const raw: Record<string, unknown> = {};
const started = new Date();

class Abort extends Error {}

const hb = (v: string | number | bigint | undefined) => formatHbar(BigInt(v ?? 0));
const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function record(step: string, what: string, links: Link[] = []) {
  const row = { step, at: now(), what, links };
  rows.push(row);
  console.log(`  ✓ [${step}] ${what}`);
  for (const l of links) console.log(`      ${l.label}: ${l.url.includes("#stub") ? "(stub, no explorer page)" : l.url}`);
}

const tx = (label: string, id: string | undefined | null): Link[] => (id ? [{ label, url: txUrl(id) }] : []);

// ── HTTP against the running app ────────────────────────────────────────────

const turnTokens = new Map<string, string>();
let ownerCookie: string | undefined;

async function call<T>(method: "GET" | "POST", p: string, body?: unknown, opts: { owner?: boolean; timeoutMs?: number } = {}) {
  const headers: Record<string, string> = { accept: "application/json" };
  const turnToken = turnTokens.get(/^\/api\/siege\/([^/]+)\/message$/.exec(p)?.[1] ?? "");
  if (turnToken) headers["x-siege-turn-token"] = turnToken;
  if (body !== undefined) headers["content-type"] = "application/json";
  if (opts.owner && ownerCookie) headers.cookie = ownerCookie;
  let res: Response;
  try {
    res = await fetch(`${APP}${p}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
  } catch (e) {
    throw new Abort(`${method} ${p} could not reach ${APP}: ${e instanceof Error ? e.message : e}. Is \`npm run dev\` running?`);
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  const started = data as { siegeId?: string; turnToken?: string } | null;
  if (started && typeof started === "object" && started.siegeId && started.turnToken) turnTokens.set(started.siegeId, started.turnToken);
  return { res, status: res.status, data: data as T };
}

async function ok<T>(method: "GET" | "POST", p: string, body?: unknown, opts: { owner?: boolean; timeoutMs?: number } = {}): Promise<T> {
  const r = await call<T>(method, p, body, opts);
  if (r.status < 200 || r.status >= 300) throw new Abort(`${method} ${p} -> ${r.status} ${JSON.stringify(r.data).slice(0, 400)}`);
  return r.data;
}

const getCastle = (id: string) => ok<CastleDetail>("GET", `/api/castles/${encodeURIComponent(id)}`);

/**
 * GET /api/castles/[id] audit rows as the server sends them since the HCS outbox (lib/chain/outbox.ts):
 * `seq` is null until the worker has submitted the row; `localSeq` is the topic's queue order.
 */
type TrailMsg = Omit<CastleDetail["audit"]["messages"][number], "seq"> & { seq: number | null; localSeq?: number; state?: string };
const trailOf = (d: CastleDetail) => d.audit.messages as unknown as TrailMsg[];
const DRAIN_TIMEOUT_MS = ALLOW_STUB ? 30_000 : 8 * 60_000;
const getSiege = async (id: string) => (await ok<SiegeDetail>("GET", `/api/siege/${encodeURIComponent(id)}`)).siege;
const getAgent = (id: string) => ok<AgentDetail>("GET", `/api/agents/${encodeURIComponent(id)}`);

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let dots = 0;
  for (;;) {
    const v = await probe();
    if (v !== undefined) {
      if (dots) process.stdout.write("\n");
      return v;
    }
    if (Date.now() > deadline) {
      if (dots) process.stdout.write("\n");
      throw new Abort(`timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${what}. Is \`npm run worker\` running?`);
    }
    if (dots++ === 0) process.stdout.write(`      waiting for ${what} `);
    else if (dots % 5 === 0) process.stdout.write(".");
    await sleep(POLL_MS);
  }
}

/** Poll a siege until the worker has put its result on chain (attempt or release), or gave up. */
function waitSettled(siegeId: string, what: string): Promise<Siege> {
  return until(what, SETTLE_TIMEOUT_MS, async () => {
    const s = await getSiege(siegeId);
    if (s.attempt || s.release) return s;
    const st = s.settlement?.state;
    if (st === "failed" || st === "void") throw new Abort(`siege ${siegeId} settlement ${st}: ${s.settlement?.reason ?? "no reason"}`);
    return undefined;
  });
}

/**
 * One paid op, paid from the script's OWN operator account (the demo raider) with its own x402 client:
 * POST /api/siege/start -> 402 -> sign -> retry, spend-capped at the castle's fee. Stub (--allow-stub):
 * the stub payer header, as "0.0.stub-raider" unless RAIDER_OPERATOR_ID is set.
 */
async function startPaid(castle: Castle): Promise<{ siegeId: string; turnToken?: string; receipt?: { txId?: string; payer?: string; amount?: string } }> {
  const accountId = process.env.RAIDER_OPERATOR_ID || (ALLOW_STUB ? "0.0.stub-raider" : "");
  const privateKey = process.env.RAIDER_OPERATOR_KEY || undefined;
  if (!accountId || (!ALLOW_STUB && !privateKey)) {
    throw new Abort("Set RAIDER_OPERATOR_ID / RAIDER_OPERATOR_KEY: the golden run pays its ops from that account over x402.");
  }
  const payer = createPayerFetch({ accountId, privateKey, perPaymentCap: castle.fee });
  let res: Response;
  try {
    res = await payer(`${APP}/api/siege/start`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ castleId: castle.id }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (e) {
    throw new Abort(`x402 payment for ${castle.name} failed: ${e instanceof Error ? e.message : e}`);
  }
  const data = (await res.json().catch(() => null)) as { siegeId?: string; turnToken?: string; receipt?: { txId?: string; payer?: string; amount?: string } } | null;
  if (res.status !== 200 || !data?.siegeId) {
    throw new Abort(`POST /api/siege/start on ${castle.name} -> ${res.status} ${JSON.stringify(data).slice(0, 400)}`);
  }
  if (data.turnToken) turnTokens.set(data.siegeId, data.turnToken);
  return { siegeId: data.siegeId, turnToken: data.turnToken, receipt: data.receipt };
}

async function playSiege(castle: Castle, msgs: readonly string[]): Promise<{ siegeId: string; receiptTx?: string; siege: Siege }> {
  const r = { data: await startPaid(castle) };
  const siegeId = r.data.siegeId;
  let last: Siege | undefined;
  for (const text of msgs) {
    const m = await call<{ siege?: Siege; error?: string }>("POST", `/api/siege/${siegeId}/message`, { text }, { timeoutMs: 180_000 });
    if (m.status !== 200 || !m.data?.siege) throw new Abort(`message on ${siegeId} -> ${m.status} ${JSON.stringify(m.data).slice(0, 300)}`);
    last = m.data.siege;
    if (last.status !== "in_progress") break;
  }
  return { siegeId, receiptTx: r.data.receipt?.txId, siege: last! };
}

// ── Mirror node + Sourcify (read-only) ──────────────────────────────────────

type HcsMsg = { topicId: string; seq: number; consensus: string; type: string; siegeId?: string; txId?: string; runningHash: string };

async function topicMessages(topicId: string, pages = 4): Promise<HcsMsg[]> {
  const out: HcsMsg[] = [];
  let next: string | null = `/api/v1/topics/${encodeURIComponent(topicId)}/messages?order=desc&limit=100`;
  for (let i = 0; next && i < pages; i++) {
    const res = await fetch(`${MIRROR}${next}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`mirror ${topicId}: HTTP ${res.status}`);
    const body = (await res.json()) as {
      messages?: { message: string; sequence_number: number; consensus_timestamp: string; running_hash: string; chunk_info?: { initial_transaction_id?: { account_id: string; transaction_valid_start: string } } }[];
      links?: { next?: string | null };
    };
    for (const m of body.messages ?? []) {
      let j: Record<string, unknown> = {};
      try {
        j = JSON.parse(Buffer.from(m.message, "base64").toString("utf8"));
      } catch {
        /* not ours */
      }
      const t = m.chunk_info?.initial_transaction_id;
      out.push({
        topicId,
        seq: m.sequence_number,
        consensus: m.consensus_timestamp,
        type: typeof j.type === "string" ? j.type : "?",
        siegeId: typeof j.siegeId === "string" && j.siegeId ? j.siegeId : undefined,
        txId: t ? `${t.account_id}@${t.transaction_valid_start}` : undefined,
        runningHash: Buffer.from(m.running_hash, "base64").toString("hex"),
      });
    }
    next = body.links?.next ?? null;
  }
  return out;
}

async function sourcify(address: string): Promise<{ match: string; verifiedAt?: string; url: string }> {
  const url = `${SOURCIFY}/${address}`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (res.status === 404) return { match: "not verified", url };
    if (!res.ok) return { match: `unknown (HTTP ${res.status})`, url };
    const j = (await res.json()) as { match?: string | null; verifiedAt?: string };
    return { match: j.match ?? "not verified", verifiedAt: j.verifiedAt, url };
  } catch (e) {
    return { match: `unknown (${e instanceof Error ? e.message : e})`, url };
  }
}

// ── The run ─────────────────────────────────────────────────────────────────

const castleSieges: Record<string, Set<string>> = {};
function track(castleId: string, siegeId: string) {
  (castleSieges[castleId] ??= new Set()).add(siegeId);
}

async function main() {
  console.log(`Siege golden run -> ${APP}`);

  // ── Preflight: everything we need, before anything is spent ────────────────
  const cfg = await ok<ConfigResponse>("GET", "/api/config");
  if (cfg.chain.mode !== "testnet") {
    if (!ALLOW_STUB) throw new Abort(`GET /api/config says chain.mode "${cfg.chain.mode}". The golden run only runs against a testnet app (CHAIN_MODE=testnet).`);
    console.log("\n  !! --allow-stub: running against a STUB app. Nothing here is on chain; output goes to the sample file.\n");
  }
  // --allow-stub is for testing this script on a stub app only: against a testnet app it would spend real HBAR and write real links into the sample file.
  if (ALLOW_STUB && cfg.chain.mode === "testnet") throw new Abort("--allow-stub is only for a stub app, and GET /api/config says testnet. Drop --allow-stub for the real run.");
  if (ALLOW_STUB && path.basename(OUT) === "golden-run.md") throw new Abort("--allow-stub never writes docs/golden-run.md (stub ids are not submission links).");
  // Which guardian answers (the Next process's GUARDIAN_MODE). Older apps don't report it.
  const guardianMode = (cfg as ConfigResponse & { guardianMode?: string }).guardianMode ?? "unknown";
  raw.guardianMode = guardianMode;
  if (REQUIRE_0G && guardianMode !== "0g") throw new Abort(`--require-0g: GET /api/config says the guardian is "${guardianMode}". Start the app with GUARDIAN_MODE=0g and ZG_API_KEY set.`);
  if (cfg.chain.mode === "testnet" && guardianMode !== "0g") {
    console.log(`\n  !! guardian mode is "${guardianMode}", not 0G: replies come from the deterministic stub guardian ("0g-stub-…" request ids). The report says so.\n`);
  }

  const board = await ok<{ castles: Castle[]; arkiv: ArkivReadMeta }>("GET", "/api/castles");
  const guarding = (c: Castle) => c.vaultState === "guarding" && c.status === "open" && c.transport === "hosted";
  const stones = board.castles.filter((c) => c.tier === "stone" && guarding(c));
  const hold = stones.find((c) => c.id === "castle_granite_hold") ?? stones[0];
  if (!hold) throw new Abort("no guarding hosted stone castle on the board. Run `npm run seed` first.");
  const wooden = board.castles.find((c) => c.id === "castle_splinter_gate") ?? board.castles.find((c) => c.tier === "wooden" && c.transport === "hosted");
  if (!wooden) throw new Abort("no wooden castle found. Run `npm run seed` first.");
  if (!guarding(wooden)) {
    throw new Abort(`${wooden.name} is ${wooden.status}/${wooden.vaultState}, so it cannot be broken again. Run \`npm run seed -- --rearm wooden\` first, then re-run the golden run.`);
  }

  let agent: RaiderAgent | undefined;
  let agentCastle: Castle | undefined;
  if (WITH_AGENT) {
    const ownerKey = process.env.OWNER_SECRET;
    if (!ownerKey) throw new Abort("--agent needs OWNER_SECRET (frontend/.env.local).");
    const { agents } = await ok<{ agents: RaiderAgent[] }>("GET", "/api/agents");
    agent = agents.find((a) => a.name === "Night Sapper") ?? agents.find((a) => a.name.startsWith("Night Sapper") && !a.name.includes("(stub)"));
    if (!agent) throw new Abort("no Night Sapper agent. Run `npm run seed` first.");
    if (!ALLOW_STUB && isStubRef(agent.accountId)) throw new Abort(`Night Sapper has a stub account (${agent.accountId}). Run \`npm run seed\` on testnet first.`);
    const wanted = opt("--agent-castle");
    agentCastle = wanted
      ? board.castles.find((c) => c.id === wanted || c.name === wanted)
      : stones.find((c) => c.id === "castle_grey_bastion") ?? stones.find((c) => c.id !== hold.id) ?? hold;
    if (!agentCastle || !guarding(agentCastle)) throw new Abort(`agent castle ${wanted ?? "(stone)"} is not a guarding hosted castle.`);
  }

  // ── The plan and its cost ──────────────────────────────────────────────────
  const raiderSpend = BigInt(hold.fee) + BigInt(wooden.fee);
  console.log("\nPlan:");
  console.log(`  guardian: ${guardianMode}`);
  console.log(`  (a) record config, SiegeVault ${cfg.chain.vaultAddress ?? "(none)"} + Sourcify status, the 402 challenge`);
  console.log(`  (b) paid hold on ${hold.name} (${hold.tier}, fee ${hb(hold.fee)}), five MUST_NOT_BREAK messages`);
  console.log(`  (c) paid break on ${wooden.name} (${wooden.tier}, fee ${hb(wooden.fee)}, pot ${hb(wooden.pot)} pays out to the demo raider)`);
  if (agent && agentCastle) {
    console.log(`  (d) ${agent.name} (${agent.accountId}) on ${agentCastle.name}: approve the first cap request, deny the second`);
  }
  console.log("  (e) HCS messages from the mirror node, the board's Arkiv read");
  console.log(`  (f) write ${OUT}`);
  console.log("\nCost (testnet HBAR):");
  console.log(`  demo raider pays ${hb(raiderSpend)} in siege fees (${hb(hold.fee)} + ${hb(wooden.fee)}); the break returns ${hb(BigInt(wooden.pot) + BigInt(wooden.fee))} to it`);
  console.log("  the arena operator pays the gas for recordAttempt + release and the HCS messages; the facilitator pays the x402 network fees");
  if (agent && agentCastle) {
    const cap = BigInt(agent.perCastleCap);
    console.log(`  ${agent.name} pays up to ~${hb(cap * BigInt(2))} in siege fees from its own account (${hb(agentCastle.fee)} each);`);
    console.log(`  the approval sends it a top-up of about ${hb(cap)} from the treasury`);
  }
  if (!YES) {
    console.log("\nNothing spent. Re-run with --yes to go:  npm run golden -- --yes" + (WITH_AGENT ? " --agent" : ""));
    process.exit(0);
  }

  // ── (a) Config, contract, Sourcify, the 402 challenge ─────────────────────
  console.log("\n(a) Config and contract");
  raw.config = cfg;
  record("a", `App ${APP} on ${cfg.chain.network} (chain mode ${cfg.chain.mode}, EVM chain id ${cfg.chain.chainId}, guardian ${guardianMode}); asset ${cfg.asset.symbol ?? cfg.asset.id}; fee split ${cfg.feeSplitBps.castellan}/${cfg.feeSplitBps.pot}/${cfg.feeSplitBps.arena} bps (castellan/pot/arena)`, [
    ...(cfg.chain.treasury ? [{ label: `treasury ${cfg.chain.treasury}`, url: accountUrl(cfg.chain.treasury) }] : []),
  ]);
  if (cfg.chain.vaultAddress) {
    const sf = await sourcify(cfg.chain.vaultAddress);
    raw.sourcify = sf;
    record("a", `SiegeVault ${cfg.chain.vaultAddress}: Sourcify ${sf.match}${sf.verifiedAt ? ` (verified ${sf.verifiedAt})` : ""}`, [
      { label: "HashScan contract", url: contractUrl(cfg.chain.vaultAddress) },
      { label: "Sourcify", url: sf.url },
    ]);
  } else {
    record("a", "No VAULT_ADDRESS configured (stub app): no contract to verify");
  }
  const challenge = await call<{ x402Version?: number; accepts?: { scheme?: string; network?: string; amount?: string; asset?: string; payTo?: string; extra?: Record<string, unknown> }[] }>(
    "POST", "/api/siege/start", { castleId: hold.id });
  if (challenge.status !== 402) throw new Abort(`unpaid POST /api/siege/start -> ${challenge.status}, expected 402`);
  const acc = challenge.data?.accepts?.[0];
  raw.challenge = { status: challenge.status, paymentRequired: Boolean(challenge.res.headers.get("payment-required")), accepts: challenge.data?.accepts };
  const feePayer = typeof acc?.extra?.feePayer === "string" ? acc.extra.feePayer : undefined;
  record("a", `Unpaid POST /api/siege/start -> 402 + PAYMENT-REQUIRED: x402 v${challenge.data?.x402Version} ${acc?.scheme} on ${acc?.network}, ${acc?.amount} tinybar of ${acc?.asset} to ${acc?.payTo}${feePayer ? `, facilitator fee payer ${feePayer}` : ""}`, [
    ...(acc?.payTo ? [{ label: `payTo ${acc.payTo}`, url: accountUrl(acc.payTo) }] : []),
    ...(feePayer ? [{ label: `fee payer ${feePayer}`, url: accountUrl(feePayer) }] : []),
  ]);

  // ── (b) Paid hold on a stone castle ───────────────────────────────────────
  console.log(`\n(b) Paid hold on ${hold.name}`);
  const potBefore = BigInt((await getCastle(hold.id)).castle.pot);
  const b = await playSiege(hold, MUST_NOT_BREAK);
  track(hold.id, b.siegeId);
  record("b", `x402 payment settled: demo raider paid ${hb(hold.fee)} for siege ${b.siegeId} on ${hold.name}`, tx("x402 settlement", b.receiptTx));
  record("b", `Five MUST_NOT_BREAK messages: siege ${b.siege.status} after ${b.siege.turn} turns`);
  const bs = await waitSettled(b.siegeId, `recordAttempt for ${b.siegeId}`);
  if (!bs.attempt) throw new Abort(`${hold.name} did not hold (status ${bs.status}, release ${bs.release?.txId}). Re-run on another stone castle.`);
  const holdAfter = (await getCastle(hold.id)).castle;
  record("b", `SiegeVault.recordAttempt: fee split on chain; pot ${hb(potBefore)} -> ${hb(holdAfter.pot)}, streak ${holdAfter.streak}`, tx("recordAttempt (AttemptRecorded)", bs.attempt.txId));
  raw.hold = { castleId: hold.id, vaultId: hold.vaultId, siegeId: b.siegeId, receiptTx: b.receiptTx, attemptTx: bs.attempt.txId, transcriptHash: bs.transcriptHash, requestIds: bs.messages.filter((m) => m.requestId).map((m) => m.requestId) };

  // ── (c) Paid break on the wooden castle ───────────────────────────────────
  console.log(`\n(c) Paid break on ${wooden.name}`);
  const c = await playSiege(wooden, WOODEN_BREAK);
  track(wooden.id, c.siegeId);
  record("c", `x402 payment settled: demo raider paid ${hb(wooden.fee)} for siege ${c.siegeId} on ${wooden.name}`, tx("x402 settlement", c.receiptTx));
  if (c.siege.status !== "broken") throw new Abort(`${wooden.name} did not break on WOODEN_BREAK (status ${c.siege.status} after ${c.siege.turn} turns). The fee split will still settle; check the guardian mode.`);
  const tool = c.siege.messages.at(-1)?.requestId;
  record("c", `WOODEN_BREAK: the guardian called ${wooden.protectedTool} on turn ${c.siege.turn}${tool ? ` (request ${tool})` : ""}`);
  const cs = await waitSettled(c.siegeId, `release for ${c.siegeId}`);
  if (!cs.release) throw new Abort(`siege ${c.siegeId} settled without a release (attempt ${cs.attempt?.txId}).`);
  record("c", `Verifier signed (EIP-712) and SiegeVault.release paid ${hb(cs.release.amount)} (pot + fee) to the raider`, tx("release (Breached)", cs.release.txId));
  raw.break = { castleId: wooden.id, vaultId: wooden.vaultId, siegeId: c.siegeId, receiptTx: c.receiptTx, releaseTx: cs.release.txId, amount: cs.release.amount, transcriptHash: cs.transcriptHash, requestIds: cs.messages.filter((m) => m.requestId).map((m) => m.requestId) };
  // Which guardian actually answered the hold and the break: "0g-stub-…" request ids come from the stub guardian.
  const replyIds = [...bs.messages, ...cs.messages].map((m) => m.requestId).filter((id): id is string => typeof id === "string" && id.length > 0);
  const stubReplies = replyIds.filter((id) => id.startsWith("0g-stub-")).length;
  raw.guardianReplies = { total: replyIds.length, stub: stubReplies };
  if (stubReplies > 0 && cfg.chain.mode === "testnet") console.log(`  !! ${stubReplies}/${replyIds.length} guardian replies came from the stub guardian (0g-stub- request ids).`);

  // ── (d) The agent: approve once, deny the second ──────────────────────────
  if (agent && agentCastle) {
    console.log(`\n(d) ${agent.name} on ${agentCastle.name}`);
    const login = await call<{ ok?: boolean }>("POST", "/api/owner", { key: process.env.OWNER_SECRET });
    if (login.status !== 200) throw new Abort(`POST /api/owner -> ${login.status}: OWNER_SECRET does not match the app's.`);
    ownerCookie = (login.res.headers.get("set-cookie") ?? "").split(";")[0];
    if (!ownerCookie) throw new Abort("POST /api/owner set no cookie.");
    const pendingFor = async (exclude: Set<string>) => {
      const { approvals } = await ok<{ approvals: ApprovalRequest[] }>("GET", "/api/approvals?status=pending");
      return approvals.find((a) => a.agentId === agent!.id && !exclude.has(a.id));
    };
    const seen = new Set<string>();
    let first = await pendingFor(seen);
    if (!first) {
      const cur = (await getAgent(agent.id)).agent;
      if (cur.status === "paused") throw new Abort(`${agent.name} is paused with no pending approval. Stop it on /raider and re-run.`);
      if (cur.status !== "running") {
        await ok("POST", `/api/agents/${agent.id}/run`, { castleId: agentCastle.id }, { owner: true });
        record("d", `Owner sent ${agent.name} (its own account ${agent.accountId}, per-castle cap ${hb(agent.perCastleCap)}) to ${agentCastle.name}; it pays for every siege itself over x402, no human approval`, [
          { label: `agent account ${agent.accountId}`, url: accountUrl(agent.accountId) },
        ]);
      }
      first = await until(`${agent.name}'s first approval request`, APPROVAL_TIMEOUT_MS, () => pendingFor(seen));
    }
    seen.add(first.id);
    record("d", `Cap hit (${first.reason}): ${agent.name} paused and asked its owner for ${hb(first.amount)}: "${first.reasoning}"`);
    const approved = await ok<{ approval: ApprovalRequest }>("POST", `/api/approvals/${first.id}`, { decision: "approved" }, { owner: true, timeoutMs: 180_000 });
    record("d", `Owner approved: top-up of ${hb(first.amount)} from the treasury to the agent's account; the agent resumed`, tx("top-up transfer", approved.approval.topUp?.txId));
    const second = await until(`${agent.name}'s second approval request`, APPROVAL_TIMEOUT_MS, () => pendingFor(seen));
    record("d", `Cap hit again (${second.reason}): asked for ${hb(second.amount)}`);
    const denied = await ok<{ approval: ApprovalRequest }>("POST", `/api/approvals/${second.id}`, { decision: "denied" }, { owner: true });
    const stopped = await until(`${agent.name} to stop`, 2 * 60_000, async () => {
      const a = (await getAgent(agent!.id)).agent;
      return a.status === "stopped" ? a : undefined;
    });
    const castleNow = (await getCastle(agentCastle.id)).castle;
    record("d", `Owner denied: ${agent.name} ${stopped.status}, ${agentCastle.name} stands (pot ${hb(castleNow.pot)}, streak ${castleNow.streak})`);
    const detail = await getAgent(agent.id);
    const runSieges = detail.sieges.filter((s) => s.createdAt >= started.toISOString());
    for (const s of runSieges) {
      track(s.castleId, s.id);
      const r = s.receipt && !s.receipt.free ? s.receipt : undefined;
      record("d", `Agent siege ${s.id}: ${r ? `${r.payer} paid ${hb(r.amount)}` : "no receipt"}, ${s.status}`, [
        ...tx("x402 settlement (agent account)", r?.txId),
        ...tx(s.release ? "release" : "recordAttempt", s.release?.txId ?? s.attempt?.txId),
      ]);
    }
    raw.agent = {
      agentId: agent.id,
      accountId: agent.accountId,
      castleId: agentCastle.id,
      approved: { id: first.id, reason: first.reason, amount: first.amount, topUpTx: approved.approval.topUp?.txId },
      denied: { id: second.id, reason: second.reason, amount: second.amount, status: denied.approval.status },
      sieges: runSieges.map((s) => ({ id: s.id, status: s.status, receiptTx: s.receipt && !s.receipt.free ? s.receipt.txId : undefined, attemptTx: s.attempt?.txId, releaseTx: s.release?.txId })),
    };
  }

  // ── (e) HCS audit + the Arkiv board read ──────────────────────────────────
  console.log("\n(e) HCS audit and the board read");
  const hcs: HcsMsg[] = [];
  const topics: Record<string, { topicId: string | null; castle: string; appTrail: TrailMsg[] }> = {};
  for (const castleId of Object.keys(castleSieges)) {
    // The worker submits each topic's queued audit rows one receipt at a time (~3-5 s each on testnet), so
    // a busy castle can trail the run by minutes: wait for its outbox to empty before reading the topic.
    let d = await getCastle(castleId);
    const drainStart = Date.now();
    const queued = (x: CastleDetail) => trailOf(x).filter((m) => m.seq == null || (m.state !== undefined && m.state !== "submitted")).length;
    const waited = queued(d) > 0;
    if (waited) process.stdout.write(`      waiting for ${d.castle.name}'s HCS outbox to drain (${queued(d)} queued) `);
    while (queued(d) && Date.now() - drainStart < DRAIN_TIMEOUT_MS) {
      await sleep(POLL_MS);
      process.stdout.write(".");
      d = await getCastle(castleId);
    }
    if (waited) process.stdout.write("\n");
    if (queued(d)) console.log(`      ${d.castle.name}: ${queued(d)} audit message(s) still queued after ${Math.round(DRAIN_TIMEOUT_MS / 1000)} s; is \`npm run worker\` running? Recording what has landed.`);
    const ours = castleSieges[castleId];
    topics[castleId] = { topicId: d.audit.topicId, castle: d.castle.name, appTrail: trailOf(d).filter((m) => (m.siegeId ? ours.has(m.siegeId) : m.at >= started.toISOString())) };
    const topicId = d.audit.topicId;
    if (!topicId || isStubRef(topicId)) {
      record("e", `${d.castle.name}: audit topic ${topicId ?? "none"} (stub), ${topics[castleId].appTrail.length} messages in the app's copy`);
      continue;
    }
    // The mirror lags consensus by a few seconds: retry until every siege of ours has its siege.end.
    let mine: HcsMsg[] = [];
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        const all = await topicMessages(topicId);
        // Our sieges' messages, plus this run's approvals and vault transitions (they carry no siege id).
        mine = all.filter((m) => (m.siegeId && ours.has(m.siegeId)) || (!m.siegeId && Number(m.consensus) * 1000 >= started.getTime()));
        const ended = new Set(mine.filter((m) => m.type === "siege.end").map((m) => m.siegeId));
        if ([...ours].every((id) => ended.has(id))) break;
      } catch (e) {
        console.log(`      mirror: ${e instanceof Error ? e.message : e}`);
      }
      await sleep(5_000);
    }
    hcs.push(...mine.sort((x, y) => x.seq - y.seq));
    record("e", `${d.castle.name}: ${mine.length} HCS messages for this run on topic ${topicId} (mirror node), types ${[...new Set(mine.map((m) => m.type))].join(", ")}`, [
      { label: `topic ${topicId}`, url: topicUrl(topicId) },
    ]);
  }
  raw.topics = Object.fromEntries(Object.entries(topics).map(([k, v]) => [k, v.topicId]));
  const boardNow = await ok<{ castles: Castle[]; arkiv: ArkivReadMeta }>("GET", "/api/castles");
  raw.arkiv = boardNow.arkiv;
  record("e", `Board read GET /api/castles: source ${boardNow.arkiv.source}${boardNow.arkiv.block ? ` at Arkiv block ${boardNow.arkiv.block}` : ""}; ${boardNow.castles.length} castles; query \`${boardNow.arkiv.query}\`${boardNow.arkiv.error ? ` (fell back: ${boardNow.arkiv.error})` : ""}`);

  // ── (f) Write the report ──────────────────────────────────────────────────
  const md = render(cfg, hcs, topics, boardNow.arkiv);
  mkdirSync(path.dirname(OUT), { recursive: true });
  const tmp = `${OUT}.tmp-${process.pid}`;
  writeFileSync(tmp, md);
  renameSync(tmp, OUT);
  console.log(`\nPASS — golden run written to ${OUT}`);
}

// ── Markdown ────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
function linkMd(l: Link): string {
  if (l.url === "#stub" || l.url.includes("#stub")) return `${esc(l.label)} (stub, no explorer page)`;
  return `[${esc(l.label)}](${l.url})`;
}
const hhmmss = (iso: string) => iso.slice(11, 19);

function render(cfg: ConfigResponse, hcs: HcsMsg[], topics: Record<string, { topicId: string | null; castle: string; appTrail: TrailMsg[] }>, arkiv: ArkivReadMeta): string {
  const L: string[] = [];
  const stub = cfg.chain.mode !== "testnet";
  L.push(stub ? "# Golden run (SAMPLE, stub app)" : "# Golden run");
  L.push("");
  if (stub) {
    L.push("> **Sample output.** Generated by `npm run golden -- --yes --agent --allow-stub` against a local STUB app, to show the format.");
    L.push("> Every siege, payment, topic and account id here is a stub (`stub:` / `0.0.stub-…`) and nothing is on chain; only the SiegeVault address and its");
    L.push("> Sourcify status are real (the stub app was given VAULT_ADDRESS). The app's copy of a stub trail shows at most its 25 latest messages.");
    L.push("> The real capture is `docs/golden-run.md`, written at the freeze.");
  } else {
    L.push(`> Captured by \`npm run golden\` against ${APP} on Hedera testnet. Every link below is a real testnet transaction, contract or topic.`);
  }
  L.push("");
  L.push(`- Started: ${started.toISOString()}`);
  L.push(`- Finished: ${now()}`);
  L.push(`- Chain mode: \`${cfg.chain.mode}\`, network \`${cfg.chain.network}\`, EVM chain id ${cfg.chain.chainId}`);
  if (cfg.chain.vaultAddress) L.push(`- SiegeVault: ${linkMd({ label: cfg.chain.vaultAddress, url: contractUrl(cfg.chain.vaultAddress) })}${raw.sourcify ? `, Sourcify: **${(raw.sourcify as { match: string }).match}**` : ""}`);
  {
    const g = raw.guardianReplies as { total: number; stub: number } | undefined;
    const who = !g || g.total === 0 ? "" : g.stub === 0 ? `, all ${g.total} replies from the 0G proxy` : g.stub === g.total ? `, all ${g.total} replies from the deterministic stub guardian (\`0g-stub-…\` request ids)` : `, ${g.stub}/${g.total} replies from the stub guardian`;
    L.push(`- Guardian: \`${String(raw.guardianMode ?? "unknown")}\`${who}`);
  }
  if (cfg.chain.treasury) L.push(`- Arena treasury (x402 \`payTo\`): ${linkMd({ label: cfg.chain.treasury, url: accountUrl(cfg.chain.treasury) })}`);
  L.push(`- Board read: \`${arkiv.source}\`${arkiv.block ? ` at Arkiv block ${arkiv.block}` : ""}`);
  L.push("");
  L.push("## Steps");
  L.push("");
  L.push("| Time (UTC) | Step | What happened | Link |");
  L.push("|---|---|---|---|");
  for (const r of rows) L.push(`| ${hhmmss(r.at)} | ${r.step} | ${esc(r.what)} | ${r.links.map(linkMd).join("<br>") || ""} |`);
  L.push("");
  L.push("Steps: **a** config and contract, **b** paid hold, **c** paid break, **d** raider agent with owner approval, **e** HCS audit and board read.");
  L.push("");
  L.push("## HCS audit messages for this run");
  L.push("");
  for (const [castleId, t] of Object.entries(topics)) {
    const mine = hcs.filter((m) => m.topicId === t.topicId);
    L.push(`### ${t.castle} (\`${castleId}\`), topic ${t.topicId ? linkMd({ label: t.topicId, url: topicUrl(t.topicId) }) : "none"}`);
    L.push("");
    if (mine.length) {
      L.push("| Seq | Consensus time | Type | Siege | Submit tx | Running hash |");
      L.push("|---|---|---|---|---|---|");
      for (const m of mine) {
        const when = new Date(Number(m.consensus) * 1000).toISOString();
        L.push(`| ${m.seq} | ${when} | \`${m.type}\` | ${m.siegeId ? `\`${m.siegeId}\`` : ""} | ${m.txId ? linkMd({ label: m.txId, url: txUrl(m.txId) }) : ""} | \`${m.runningHash.slice(0, 16)}…\` |`);
      }
    } else {
      L.push("From the app's copy of the trail (stub topics have no mirror node):");
      L.push("");
      L.push("| Seq | At | Type | Siege |");
      L.push("|---|---|---|---|");
      const order = (m: TrailMsg) => m.localSeq ?? m.seq ?? Number.MAX_SAFE_INTEGER;
      for (const m of [...t.appTrail].sort((x, y) => order(x) - order(y)))
        L.push(`| ${m.seq ?? "queued"} | ${m.at} | \`${m.type}\` | ${m.siegeId ? `\`${m.siegeId}\`` : ""} |`);
    }
    L.push("");
  }
  L.push("## Board read (Arkiv)");
  L.push("");
  L.push(`- Source: \`${arkiv.source}\`${arkiv.block ? `, block ${arkiv.block}` : ""}${arkiv.error ? `, fallback reason: ${arkiv.error}` : ""}`);
  L.push("- Query:");
  L.push("");
  L.push("```");
  L.push(arkiv.query);
  L.push("```");
  L.push("");
  L.push("## Raw ids");
  L.push("");
  L.push("```json");
  L.push(JSON.stringify(raw, null, 2));
  L.push("```");
  L.push("");
  return L.join("\n");
}

main().catch((e) => {
  if (e instanceof Abort) console.error(`\n✗ ABORTED: ${e.message}`);
  else console.error("\n✗ golden run crashed:", e instanceof Error ? e.stack : e);
  if (rows.length) {
    console.error("\nWhat completed before the abort (nothing was written; these links are real):");
    for (const r of rows) console.error(`  ${r.at} [${r.step}] ${r.what}${r.links.length ? `\n      ${r.links.map((l) => `${l.label}: ${l.url}`).join("\n      ")}` : ""}`);
  }
  process.exit(1);
});
