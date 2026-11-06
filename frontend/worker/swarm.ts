/**
 * The Swarm loop inside the worker (SWARM_MODE=live only): retry uploads that failed at siege end,
 * and re-upload every transcript from the last week twice a day. The public gateway stamps uploads
 * with batches that last about a day; the same bytes land on the same reference, so a re-upload
 * extends the transcript's life without touching the siege entity. One pass a minute.
 *
 * A reference that lands here (not at siege end) is news for Arkiv: the siege entity was published
 * without it, and the reconciler only revisits sieges that ended minutes ago. So every landed or
 * changed reference re-queues the siege through the Arkiv port.
 */
import { arkiv } from "@/lib/arkiv";
import { getSiege } from "@/lib/siege/read";
import { liveSwarm } from "@/lib/swarm";
import type { LiveSwarm } from "@/lib/swarm/live";
import { log } from "./log";

const EVERY_MS = 60_000;
let last = 0;

/** `port` is injectable for tests; the worker uses the live port for the current env. */
export async function swarmTick(now = Date.now(), port: LiveSwarm | null = liveSwarm()): Promise<void> {
  if (now - last < EVERY_MS) return;
  last = now;
  if (!port) return;
  const r = await port.tick(now);
  for (const u of r.uploaded) log.ok(`swarm: uploaded ${u.siegeId} ${u.ref}`);
  for (const u of r.refreshed) log.ok(`swarm: kept alive ${u.siegeId} ${u.ref}${u.ref === u.was ? "" : ` (was ${u.was})`}`);
  for (const e of r.errors) log.fail(`swarm: ${e}`);
  await republish([...r.uploaded, ...r.refreshed.filter((u) => u.ref !== u.was)].map((u) => u.siegeId));
}

/** Put the new reference on the siege entity. */
async function republish(siegeIds: string[]): Promise<void> {
  for (const siegeId of siegeIds) {
    const siege = getSiege(siegeId);
    if (!siege) continue;
    try {
      await arkiv.writeSiege(siege);
      log.info(`arkiv: siege ${siegeId} re-queued with its Swarm reference`);
    } catch (e) {
      log.fail(`arkiv: could not re-queue siege ${siegeId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
