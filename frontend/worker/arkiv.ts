/**
 * The Arkiv loop inside the worker (ARKIV_MODE=live only): reconcile SQLite against Arkiv, then send
 * the queue in batched transactions. Same code as `npm run arkiv`, which stays for running it alone.
 * Throttled to one pass every 3 s; the worker's other loops tick every second.
 */
import { arkivLinks } from "@/lib/arkiv/config";
import { drain } from "@/lib/arkiv/outbox";
import { reconcile } from "@/lib/arkiv/reconcile";
import { log } from "./log";

const EVERY_MS = 3_000;
const HOLDER = `worker-${process.pid}`;
let last = 0;

export async function arkivTick(now = Date.now()): Promise<void> {
  if (now - last < EVERY_MS) return;
  last = now;
  const r = reconcile(now);
  if (r.castles + r.sieges + r.profiles) log.info(`arkiv: queued ${r.castles} castle(s), ${r.sieges} siege(s), ${r.profiles} profile(s)`);
  const d = await drain({ holder: HOLDER, log: (m) => log.info(m) });
  for (const tx of d.txs) log.info(`arkiv: tx ${arkivLinks.tx(tx)}`);
  for (const e of d.errors) log.fail(`arkiv: ${e}`);
}
