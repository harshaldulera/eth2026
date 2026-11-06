#!/usr/bin/env node
/**
 * qa/plug-in.mjs — J2 end to end against a running STUB app + worker (plan §2A):
 *   start examples/guard-refund-bot as a child -> castle reaches verified -> fund -> guarding ->
 *   an op through /api/play/start is answered by the bot (requestId not sdk-stub-) ->
 *   kill the bot -> dormant within 40 s -> restart -> guarding again.
 *
 *   SIEGE_GUARD_KEY=gk_… OWNER_SECRET=… node qa/plug-in.mjs [--base http://localhost:4532] [--castle castle_refund_desk] [--bot <path>]
 * The key is printed by `npm run seed`. The app needs OWNER_SECRET set (the fund step uses the owner cookie)
 * and the worker running (dormant detection). Reset the stub DB (npm run db:reset, seed) between runs.
 */
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: process.env.QA_BASE_URL || "http://localhost:4532" },
    castle: { type: "string", default: "castle_refund_desk" },
    key: { type: "string", default: process.env.SIEGE_GUARD_KEY },
    bot: { type: "string", default: process.env.GUARD_BOT_PATH || path.resolve(HERE, "../../examples/guard-refund-bot/index.mjs") },
    owner: { type: "string", default: process.env.OWNER_SECRET },
  },
});
const BASE = args.base.replace(/\/$/, "");
let failed = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!args.key) {
  console.error("SIEGE_GUARD_KEY (or --key) is required: `npm run seed` prints it.");
  process.exit(2);
}

let bot = null;
let botOut = "";
function startBot() {
  botOut = "";
  bot = spawn(process.execPath, [args.bot], { env: { ...process.env, SIEGE_URL: BASE, SIEGE_GUARD_KEY: args.key }, stdio: ["ignore", "pipe", "pipe"] });
  bot.stdout.on("data", (d) => (botOut += d));
  bot.stderr.on("data", (d) => (botOut += d));
  return bot;
}
const killBot = () => {
  if (bot && bot.exitCode === null) bot.kill("SIGKILL");
};
process.on("exit", killBot);

const json = async (method, p, body, headers = {}) => {
  const res = await fetch(BASE + p, { method, headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
};
const castle = async () => (await json("GET", `/api/castles/${args.castle}`)).data?.castle;
async function waitState(want, ms, label) {
  const until = Date.now() + ms;
  let s;
  while (Date.now() < until) {
    s = (await castle())?.vaultState;
    if (want.includes(s)) return s;
    if (bot && bot.exitCode !== null && !label.includes("dormant")) break;
    await sleep(700);
  }
  return s;
}

// ── connect, self-check, smoke op → verified ───────────────────────────────
startBot();
let s = await waitState(["verified", "funded", "guarding"], 60_000, "verified");
check(["verified", "funded", "guarding"].includes(s), "bot connects, passes self-check + smoke op: vault verified", s);
const c1 = await castle();
check(c1?.sdk?.promptPinned === true, "system prompt pinned by the self-check", String(c1?.sdk?.promptPinned));
check(c1?.sdk?.smoke?.ok === true, "smoke op passed", JSON.stringify(c1?.sdk?.smoke));
check(/connected/.test(botOut) && /smoke op/.test(botOut), "bot printed its lifecycle lines", botOut.trim().split("\n").slice(-3).join(" | "));

// ── fund (owner cookie), guarding ───────────────────────────────────────────
if (s === "verified") {
  const login = await json("POST", "/api/owner", { key: args.owner });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0];
  check(login.status === 200 && cookie, "owner login", String(login.status));
  const fund = await json("POST", `/api/castles/${args.castle}/fund`, {}, { cookie });
  check(fund.status === 200, "POST /fund opens a deposit window", `${fund.status} ${fund.data?.state ?? fund.data?.error ?? ""}`);
}
s = await waitState(["guarding"], 45_000, "guarding");
check(s === "guarding", "vault is guarding", s);

// ── an op answered by the bot ───────────────────────────────────────────────
const start = await json("POST", "/api/play/start", { castleId: args.castle, free: false });
check(start.status === 200 && start.data?.siegeId, "POST /api/play/start", `${start.status} ${start.data?.error ?? ""}`);
if (start.data?.siegeId) {
  const id = start.data.siegeId;
  const msg = await json("POST", `/api/siege/${id}/message`, { text: "Hi Penny, where is my order A-1001?" }, { "x-siege-turn-token": start.data.turnToken });
  check(msg.status === 200, "message answered", `${msg.status} ${msg.data?.error ?? ""}`);
  const detail = (await json("GET", `/api/siege/${id}`)).data;
  const g = detail?.siege?.messages?.find((m) => m.role === "guardian");
  const rid = g?.requestId ?? "";
  check(Boolean(g?.text) && !String(rid).startsWith("sdk-stub-"), "reply came from the bot, not the stub (no sdk-stub- id)", `requestId ${rid}`);
}

// ── kill: dormant within 40 s ───────────────────────────────────────────────
killBot();
const t0 = Date.now();
s = await waitState(["dormant"], 40_000, "dormant");
check(s === "dormant", "killed bot: vault dormant within 40 s", `${s} after ${Math.round((Date.now() - t0) / 1000)}s`);

// ── restart: guarding again ─────────────────────────────────────────────────
startBot();
s = await waitState(["guarding"], 60_000, "guarding");
check(s === "guarding", "restarted bot: vault guarding again", s);
killBot();

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
