/**
 * The Swarm loop inside the worker (SWARM_MODE=live only): retry uploads that failed at siege end,
 * and re-upload every transcript from the last week twice a day. The public gateway stamps uploads
 * with batches that last about a day; the same bytes land on the same reference, so a re-upload
 * extends the transcript's life without touching the siege entity. One pass a minute.
 */
import { liveSwarm } from "@/lib/swarm";
import { log } from "./log";

const EVERY_MS = 60_000;
let last = 0;

export async function swarmTick(now = Date.now()): Promise<void> {
  if (now - last < EVERY_MS) return;
  last = now;
  const port = liveSwarm();
  if (!port) return;
  const r = await port.tick(now);
  for (const u of r.uploaded) log.ok(`swarm: uploaded ${u}`);
  for (const u of r.refreshed) log.ok(`swarm: kept alive ${u}`);
  for (const e of r.errors) log.fail(`swarm: ${e}`);
}
