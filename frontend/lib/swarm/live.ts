/**
 * The live port (SWARM_MODE=live): seal the transcript (./crypto.ts), upload it through the Bee
 * API (./gateway.ts), remember the bytes (./store.ts) and the reference (./refs.ts, which the
 * Arkiv siege entity carries as `swarmRef`).
 *
 * References: a live one is the bare 64-hex Swarm reference (openable at <gateway>/bytes/<ref>).
 * "swarm-pending:<siegeId>" means the upload has not landed yet; the worker retries it and the
 * transcript is served from the local copy meanwhile. "swarm-stub:…" is the stand-in store.
 *
 * Expected failures (gateway down, timeout) never throw into the siege state machine: `put` returns
 * the pending reference, `get` returns null.
 */
import type { SwarmPort, Transcript } from "@/lib/types";
import type { SwarmConfig } from "./config";
import { envelopeBytes, openTranscript, parseEnvelope, sealTranscript } from "./crypto";
import { downloadBytes, REFERENCE_RE, SwarmGatewayError, uploadBytes } from "./gateway";
import { recordSwarmRef } from "./refs";
import { markFailed, markUploaded, pendingUploads, rememberUpload, staleUploads, uploadRow } from "./store";
import { STUB_PREFIX, stubRead, stubStore } from "./stub";

export const PENDING_PREFIX = "swarm-pending:";
/** Re-upload every transcript this often: the public gateway's stamps last about a day. */
export const KEEP_ALIVE_MS = 12 * 60 * 60_000;
/** Transcripts older than this are no longer kept alive. */
export const KEEP_ALIVE_HORIZON_MS = 7 * 24 * 60 * 60_000;
/** A downloaded transcript is trusted for this long before "read from Swarm" is proven again. */
const READ_CACHE_MS = 10 * 60_000;

export type LiveDeps = { fetch?: typeof fetch; now?: () => number };

export type LiveSwarm = SwarmPort & {
  /** One pass of retries and keep-alive re-uploads. For the worker and tests. */
  tick(now?: number): Promise<UploadPass>;
};

export type UploadPass = { uploaded: string[]; refreshed: string[]; errors: string[] };

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);

export function createLiveSwarm(config: SwarmConfig, deps: LiveDeps = {}): LiveSwarm {
  const secret = config.secret;
  if (!secret) throw new Error("live Swarm needs SWARM_TRANSCRIPT_SECRET");
  const gw = { gatewayUrl: config.gatewayUrl, batchId: config.batchId, fetch: deps.fetch };
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, { t: Transcript; at: number }>();

  async function send(siegeId: string, body: Uint8Array): Promise<string> {
    const ref = await uploadBytes(body, gw);
    markUploaded(siegeId, ref, now());
    try {
      recordSwarmRef(siegeId, ref);
    } catch {
      // the reference is a convenience for the Arkiv siege entity; never fail an upload over it
    }
    return ref;
  }

  return {
    async put(transcript) {
      const body = envelopeBytes(sealTranscript(transcript, secret));
      stubStore(transcript); // a local copy, so a replay works while the upload is pending
      rememberUpload(transcript.siegeId, body, transcript.transcriptHash, now());
      try {
        const ref = await send(transcript.siegeId, body);
        cache.set(ref, { t: transcript, at: now() });
        return { ref };
      } catch (e) {
        markFailed(transcript.siegeId, short(e), now());
        return { ref: PENDING_PREFIX + transcript.siegeId };
      }
    },

    async get(ref) {
      if (ref.startsWith(STUB_PREFIX)) return stubRead(ref);
      if (ref.startsWith(PENDING_PREFIX)) {
        const row = uploadRow(ref.slice(PENDING_PREFIX.length));
        const env = row && parseEnvelope(row.body);
        return env ? openTranscript(env, secret) : null;
      }
      if (!REFERENCE_RE.test(ref)) return null;
      const hit = cache.get(ref);
      if (hit && now() - hit.at < READ_CACHE_MS) return hit.t;
      let bytes: Uint8Array | null;
      try {
        bytes = await downloadBytes(ref, gw);
      } catch (e) {
        if (!(e instanceof SwarmGatewayError)) throw e;
        return null;
      }
      const env = bytes && parseEnvelope(bytes);
      const t = env ? openTranscript(env, secret) : null;
      if (t) cache.set(ref, { t, at: now() });
      return t;
    },

    async tick(at = now()) {
      const out: UploadPass = { uploaded: [], refreshed: [], errors: [] };
      for (const row of pendingUploads(at)) {
        try {
          out.uploaded.push(`${row.siegeId} ${await send(row.siegeId, row.body)}`);
        } catch (e) {
          markFailed(row.siegeId, short(e), at);
          out.errors.push(`${row.siegeId}: ${short(e)}`);
        }
      }
      for (const row of staleUploads(at - KEEP_ALIVE_MS, at - KEEP_ALIVE_HORIZON_MS)) {
        try {
          const ref = await send(row.siegeId, row.body);
          out.refreshed.push(`${row.siegeId} ${ref}${ref === row.ref ? "" : ` (was ${row.ref})`}`);
        } catch (e) {
          out.errors.push(`${row.siegeId}: keep-alive ${short(e)}`);
        }
      }
      return out;
    },
  };
}
