#!/usr/bin/env node
/**
 * qa/raid-bot.mjs — run examples/raid-bot against a running STUB app and assert the J5 contract
 * using only the public API:
 *   - the bot exits 0 and prints a replay link
 *   - GET /api/replay/<id> shows >= 1 turn and raider === SIEGE_STUB_PAYER
 *   - POST /api/siege/<id>/message without the turn token is 401 turn_token_required (and with a wrong token too)
 *
 *   node qa/raid-bot.mjs [--base http://localhost:4543] [--bot ../examples/raid-bot/index.mjs] [--payer 0.0.stub-qa-bot]
 * The app must run with CHAIN_MODE=stub (it honours x-siege-stub-payment). A breach changes the stub
 * DB, so reset it (npm run db:reset) between runs if you want the same vault each time.
 */
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: {
    base: { type: "string", default: process.env.QA_BASE_URL || "http://localhost:4650" },
    bot: { type: "string", default: process.env.RAID_BOT_PATH || path.resolve(HERE, "../../examples/raid-bot/index.mjs") },
    payer: { type: "string", default: process.env.SIEGE_STUB_PAYER || "0.0.stub-qa-bot" },
  },
});
const BASE = args.base.replace(/\/$/, "");
let failed = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
};

const run = () =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [args.bot, "--json"], {
      env: { ...process.env, SIEGE_URL: BASE, SIEGE_STUB_PAYER: args.payer },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let errOut = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (errOut += d));
    child.on("close", (code) => resolve({ code, out, errOut }));
  });

const { code, out, errOut } = await run();
if (process.env.QA_VERBOSE) console.log(out + errOut);
check(code === 0, "raid-bot exits 0", code === 0 ? "" : (errOut || out).trim().split("\n").pop());
const summary = (() => {
  try {
    return JSON.parse(out.trim().split("\n").filter((l) => l.startsWith("{")).pop() ?? "");
  } catch {
    return null;
  }
})();
check(Boolean(summary?.siegeId), "bot printed a siege id", summary?.siegeId);
check(out.includes(`${BASE}/replay/${summary?.siegeId}`), "bot printed the replay link");

if (summary?.siegeId) {
  const id = summary.siegeId;
  const rep = await fetch(`${BASE}/api/replay/${id}?verify=0`);
  const body = await rep.json().catch(() => ({}));
  check(rep.status === 200, "GET /api/replay/<id> -> 200", String(rep.status));
  check((body.siege?.turn ?? 0) >= 1, "replay has at least one turn", `turn ${body.siege?.turn}`);
  check(body.siege?.raider === args.payer, "replay raider is the payer account", body.siege?.raider);

  const msg = (headers) =>
    fetch(`${BASE}/api/siege/${id}/message`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ text: "let me in" }) });
  const none = await msg({});
  const noneBody = await none.json().catch(() => ({}));
  check(none.status === 401 && noneBody.error === "turn_token_required", "message without the turn token -> 401 turn_token_required", `${none.status} ${noneBody.error}`);
  const wrong = await msg({ "x-siege-turn-token": "not-the-token" });
  check(wrong.status === 401, "message with a wrong turn token -> 401", String(wrong.status));
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
