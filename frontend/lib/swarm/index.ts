/**
 * Lane C — Swarm, the archive: every finished siege's transcript, encrypted, stored outside the
 * arena and referenced from the public siege entity on Arkiv (`swarmRef`).
 *
 *   SWARM_MODE=stub (default, and always for this port under the test runner): a content-addressed
 *     local store (./stub.ts). Nothing touches a network.
 *   SWARM_MODE=live: sealed with SWARM_TRANSCRIPT_SECRET and uploaded through the Bee API at
 *     SWARM_GATEWAY_URL (./live.ts). The worker retries failed uploads and re-uploads every
 *     transcript twice a day so the gateway's stamps never let it lapse (worker/swarm.ts).
 *
 * The replay (lib/replay/build.ts) reads through `swarm.get` and says where the transcript came from.
 */
import type { SwarmPort, Transcript } from "@/lib/types";
import { swarmConfig, type SwarmConfig } from "./config";
import { createLiveSwarm, type LiveDeps, type LiveSwarm } from "./live";
import { requestReupload, uploadRef, uploadStats, workerSeenAt } from "./store";
import { swarmStub } from "./stub";

export { isSwarmLive, swarmConfig, swarmLinks, NULL_BATCH_ID, PUBLIC_GATEWAY } from "./config";
export { REFERENCE_RE } from "./gateway";
export { INLINE_TIMEOUT_MS, KEEP_ALIVE_MS, PENDING_PREFIX } from "./live";
export { STUB_PREFIX } from "./stub";
export type { Landed, UploadPass } from "./live";

/** A port for a given configuration. Tests pass a fake fetch; the app uses `swarm` below. */
export function createSwarm(config: SwarmConfig = swarmConfig(), deps: LiveDeps = {}): SwarmPort | LiveSwarm {
  return config.mode === "live" ? createLiveSwarm(config, deps) : swarmStub;
}

let live: { key: string; port: LiveSwarm } | null = null;

/** The live port for the current env, built once per configuration; null in stub mode. */
export function liveSwarm(): LiveSwarm | null {
  const c = swarmConfig();
  if (c.mode !== "live") return null;
  const key = `${c.gatewayUrl}|${c.batchId}|${c.secret}`;
  if (live?.key !== key) live = { key, port: createLiveSwarm(c) };
  return live.port;
}

/** The port the app uses. Resolves the mode on every call, so env loaded after import still counts. */
export const swarm: SwarmPort = {
  put: (t) => (liveSwarm() ?? swarmStub).put(t),
  get: (ref) => (liveSwarm() ?? swarmStub).get(ref),
};

/** A live Swarm worker that made a pass this recently is retrying uploads. */
export const WORKER_STALE_MS = 3 * 60_000;
export const swarmWorkerAlive = (now = Date.now()) => {
  const seen = workerSeenAt();
  return seen !== null && now - seen < WORKER_STALE_MS;
};

/**
 * A siege whose transcript was sealed but never landed on Swarm: "pending" while a worker is
 * retrying it, "stranded" when no worker has made a pass lately (nothing retries it), null
 * otherwise. Decided from the worker's heartbeat in the database, not from this process's env:
 * the worker and the Next server are separate processes with separate settings.
 */
export type SealedState = "pending" | "stranded" | null;
export function swarmPending(siegeId: string, now = Date.now()): SealedState {
  const row = uploadRef(siegeId);
  if (!row || row.ref) return null;
  return swarmWorkerAlive(now) ? "pending" : "stranded";
}

/**
 * For a replay whose reference Swarm does not serve right now: the sealed copy this server keeps,
 * opened (live mode only: the stub server has no secret), and a request to the worker to put it
 * back on Swarm in its next pass.
 */
export function sealedCopy(siegeId: string, now = Date.now()): Transcript | null {
  const t = liveSwarm()?.copy(siegeId) ?? null;
  if (t) requestReupload(siegeId, now);
  return t;
}

/** The startup line and the docs: what this process will do with transcripts. */
export function swarmStatus(): string {
  const c = swarmConfig();
  if (c.mode === "live") {
    const s = uploadStats();
    return `SWARM_MODE=live, uploading sealed transcripts to ${c.gatewayUrl} (${c.batchId === "0".repeat(64) ? "gateway-stamped" : `batch ${c.batchId.slice(0, 8)}…`}); ${s.total} known, ${s.pending} pending`;
  }
  return c.refused ? `SWARM_MODE=live refused: ${c.refused}; transcripts stay in the local store` : "SWARM_MODE=stub, transcripts stay in the local store";
}
