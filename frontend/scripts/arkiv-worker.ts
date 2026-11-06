/**
 * npm run arkiv — keeps Arkiv in step with the arena (needs ARKIV_MODE=live in frontend/.env).
 *
 * Every 3 s: reconcile (queue castles, sieges and profiles whose public values changed), then drain
 * (send the queue to Arkiv in batched transactions). Run it next to `npm run dev` and
 * `npm run worker`. Only one drainer runs at a time (a lease in SQLite), so a second copy just waits.
 *
 *   npm run arkiv -- --once   one pass, then exit (scripts, CI)
 */
import "@/lib/config/load-env";
import { arkivConfig } from "@/lib/arkiv/config";
import { arenaAddress } from "@/lib/arkiv/client";
import { drain, outboxStats, releaseLease } from "@/lib/arkiv/outbox";
import { reconcile } from "@/lib/arkiv/reconcile";
import { arkivLinks } from "@/lib/arkiv/config";
import { env } from "@/lib/config/env";

const INTERVAL_MS = 3_000;
const holder = `arkiv-worker-${process.pid}`;
const ts = () => new Date().toISOString().slice(11, 19);
const log = (m: string) => console.log(`${ts()} ${m}`);

async function pass(): Promise<void> {
  const r = reconcile();
  if (r.castles + r.sieges + r.profiles) log(`queued: ${r.castles} castle(s), ${r.sieges} siege(s), ${r.profiles} profile(s)`);
  // Drain until the queue is empty or a round makes no progress.
  for (let i = 0; i < 5; i++) {
    const d = await drain({ holder, log });
    for (const tx of d.txs) log(`  tx ${arkivLinks.tx(tx)}`);
    for (const e of d.errors) log(`  FAIL ${e}`);
    if (!d.sent && !d.skipped) break;
  }
}

async function main() {
  const c = arkivConfig();
  if (c.mode !== "live") {
    console.error("ARKIV_MODE is not live (or ARKIV_PRIVATE_KEY is missing/invalid). Set ARKIV_MODE=live in frontend/.env.");
    process.exit(1);
  }
  log(`arkiv worker up — namespace "${c.namespace}", db ${env().DATABASE_URL}`);
  log(`arena wallet ${arkivLinks.address(arenaAddress())}`);
  if (!c.accessKey) log("warning: no ARKIV_ACCESS_KEY, using the rate-limited public RPC");

  if (process.argv.includes("--once")) {
    await pass();
    const s = outboxStats();
    log(`done. outbox: ${s.pending} pending, ${s.failing} failing`);
    releaseLease(holder);
    process.exit(s.failing ? 1 : 0);
  }

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    log("stopping after this pass…");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  while (!stopping) {
    try {
      await pass();
    } catch (e) {
      log(`pass failed: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
  releaseLease(holder);
  process.exit(0);
}

void main();
