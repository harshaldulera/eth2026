#!/usr/bin/env node
/**
 * Production entry point (Railway, or any single host): the web app and the worker in ONE process
 * group, because they share one SQLite file and a volume attaches to one service.
 *
 *   npm run build && npm run serve
 *
 * - web:    next start on $PORT (default 3000), all interfaces
 * - worker: tsx worker/index.ts, with APP_URL defaulting to this same server (http://127.0.0.1:$PORT)
 * If either exits, the other is stopped and this process exits non-zero, so the platform restarts both.
 * SIGTERM/SIGINT are forwarded so the worker can finish its current pass.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const port = process.env.PORT || "3000";
const env = { ...process.env, PORT: port, APP_URL: process.env.APP_URL || `http://127.0.0.1:${port}` };
mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
if (!existsSync(path.join(process.cwd(), ".next"))) {
  console.error("[serve] no .next build found: run `npm run build` first");
  process.exit(1);
}

const bin = (name) => path.join(process.cwd(), "node_modules", ".bin", name);
const children = [];
let stopping = false;

function run(label, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { env, stdio: ["ignore", "inherit", "inherit"], ...opts });
  children.push(child);
  child.on("exit", (code, signal) => {
    console.error(`[serve] ${label} exited (${signal ?? code})`);
    if (!stopping) shutdown(code === 0 ? 1 : code ?? 1);
  });
  return child;
}

function shutdown(code) {
  stopping = true;
  for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill("SIGTERM");
  setTimeout(() => process.exit(code), 8000).unref();
  Promise.all(children.map((c) => (c.exitCode !== null || c.signalCode !== null ? null : new Promise((r) => c.on("exit", r))))).then(() => process.exit(code));
}

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => (stopping ? process.exit(1) : shutdown(0)));

console.log(`[serve] web on :${port}, worker → ${env.APP_URL}, data in ${path.join(process.cwd(), "data")}`);
run("web", bin("next"), ["start", "-H", "0.0.0.0", "-p", port]);
// Give the web server a moment so the worker's first agent run can reach it.
setTimeout(() => !stopping && run("worker", bin("tsx"), ["worker/index.ts"]), 3000);
