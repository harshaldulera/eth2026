/**
 * The live port (SWARM_MODE=live): seal the transcript (./crypto.ts), upload it through the Bee
 * API (./gateway.ts), remember the bytes (./store.ts) and the reference (./refs.ts, which the
 * Arkiv siege entity carries as `swarmRef`).
 *
 * References: a live one is the bare 64-hex Swarm reference of transcript.json (opens in a browser
 * at <gateway>/bzz/<ref>/; see ./gateway.ts).
 * "swarm-pending:<siegeId>" means the upload has not landed yet; the worker retries it and the
 * transcript is opened from the sealed bytes in swarm_uploads meanwhile. "swarm-stub:…" is the
 * stand-in store (read here too, for sieges that ended before the mode went live).
 *
 * `put` runs inside the request that ends the op, so it gets a short budget (INLINE_TIMEOUT_MS)
 * and hands anything slower to the worker, which uploads with the full UPLOAD_TIMEOUT_MS.
 * Expected failures (gateway down, timeout) never throw into the siege state machine: `put`
 * returns the pending reference, `get` returns null.
 */
import type { SwarmPort, Transcript } from "@/lib/types";
import type { SwarmConfig } from "./config";
import { envelopeBytes, openTranscript, parseEnvelope, sealTranscript } from "./crypto";
import { downloadBytes, REFERENCE_RE, SwarmGatewayError, UPLOAD_TIMEOUT_MS, uploadBytes } from "./gateway";
import { forgetSwarmRef, recordSwarmRef } from "./refs";
import { markFailed, markUploaded, pendingUploads, rememberUpload, staleUploads, touchWorker, uploadRef, uploadRow } from "./store";
import { STUB_PREFIX, stubRead } from "./stub";

export const PENDING_PREFIX = "swarm-pending:";
/**
 * How long the op-ending request waits for the gateway before leaving the upload to the worker.
 * Inline at all because a normal upload takes ~0.5 s, and then the siege entity carries its
 * reference from its first write; the worker only re-queues it when this budget runs out.
 */
export const INLINE_TIMEOUT_MS = 2_500;
/** How long a replay waits for a download. */
export const READ_TIMEOUT_MS = 5_000;
/** Re-upload every transcript this often: the public gateway's stamps last about a day. */
export const KEEP_ALIVE_MS = 12 * 60 * 60_000;
/** Transcripts older than this are no longer kept alive. */
export const KEEP_ALIVE_HORIZON_MS = 7 * 24 * 60 * 60_000;
/** This many failures in a row and the pass stops: the gateway is down, no point timing out on every row. */
export const PASS_FAILURE_LIMIT = 3;
/** A downloaded transcript is trusted for this long before "read from Swarm" is proven again. */
const READ_CACHE_MS = 10 * 60_000;
/** A reference the gateway could not serve is not asked for again for this long. */
const MISS_CACHE_MS = 30_000;
/** Transcripts kept in memory for replays; the oldest goes when it is full. */
const READ_CACHE_MAX = 64;

export type LiveDeps = { fetch?: typeof fetch; now?: () => number };

export type Landed = { siegeId: string; ref: string };
/** One worker pass: uploads that landed after failing at siege end, keep-alive re-uploads (with the reference they had), failures. */
export type UploadPass = { uploaded: Landed[]; refreshed: (Landed & { was: string })[]; errors: string[] };

export type LiveSwarm = SwarmPort & {
  /** One pass of retries and keep-alive re-uploads. For the worker and tests. */
  tick(now?: number): Promise<UploadPass>;
  /** The sealed copy kept for a siege, opened: for a replay when Swarm does not answer for its reference. */
  copy(siegeId: string): Transcript | null;
};

const short = (e: unknown) => (e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200);

export function createLiveSwarm(config: SwarmConfig, deps: LiveDeps = {}): LiveSwarm {
  const secret = config.secret;
  if (!secret) throw new Error("live Swarm needs SWARM_TRANSCRIPT_SECRET");
  const gw = { gatewayUrl: config.gatewayUrl, batchId: config.batchId, fetch: deps.fetch };
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, { t: Transcript; at: number }>();
  const missed = new Map<string, number>();

  function remember(ref: string, t: Transcript) {
    cache.delete(ref);
    if (cache.size >= READ_CACHE_MAX) cache.delete(cache.keys().next().value!); // Map keeps insertion order: the oldest
    cache.set(ref, { t, at: now() });
    missed.delete(ref);
  }

  function miss(ref: string) {
    if (missed.size >= READ_CACHE_MAX) missed.clear();
    missed.set(ref, now());
  }

  async function send(siegeId: string, body: Uint8Array, timeoutMs: number): Promise<string> {
    const ref = await uploadBytes(body, { ...gw, timeoutMs });
    markUploaded(siegeId, ref, now());
    try {
      recordSwarmRef(siegeId, ref);
    } catch {
      // the reference is a convenience for the Arkiv siege entity; never fail an upload over it
    }
    return ref;
  }

  // An arrow, not a hoisted declaration, so the `secret` guard above narrows it to a string here.
  const open = (row: { body: Uint8Array } | null): Transcript | null => {
    const env = row && parseEnvelope(row.body);
    return env ? openTranscript(env, secret) : null;
  };

  return {
    async put(transcript) {
      const known = uploadRef(transcript.siegeId);
      const landed = known?.ref;
      const hash = transcript.transcriptHash.toLowerCase();
      if (landed && known.transcriptHash === hash) {
        // Already on Swarm with these exact bytes: nothing to upload; the keep-alive refreshes it.
        recordSwarmRef(transcript.siegeId, landed); // repairs a missing swarm_refs row
        return { ref: landed };
      }
      const body = envelopeBytes(sealTranscript(transcript, secret));
      // The sealed bytes in swarm_uploads are the local copy; nothing readable is written anywhere else.
      rememberUpload(transcript.siegeId, body, transcript.transcriptHash, now());
      // A different transcript for this siege: until it lands, no reference beats a stale one.
      if (known && known.transcriptHash !== hash) forgetSwarmRef(transcript.siegeId);
      try {
        // Not cached on purpose: "read from Swarm" on a replay must come from a real download.
        return { ref: await send(transcript.siegeId, body, INLINE_TIMEOUT_MS) };
      } catch (e) {
        markFailed(transcript.siegeId, short(e), now());
        return { ref: PENDING_PREFIX + transcript.siegeId };
      }
    },

    async get(ref) {
      if (ref.startsWith(STUB_PREFIX)) return stubRead(ref);
      if (ref.startsWith(PENDING_PREFIX)) return open(uploadRow(ref.slice(PENDING_PREFIX.length)));
      if (!REFERENCE_RE.test(ref)) return null;
      const hit = cache.get(ref);
      if (hit && now() - hit.at < READ_CACHE_MS) return hit.t;
      const missedAt = missed.get(ref);
      if (missedAt !== undefined && now() - missedAt < MISS_CACHE_MS) return null;
      let bytes: Uint8Array | null;
      try {
        bytes = await downloadBytes(ref, { ...gw, timeoutMs: READ_TIMEOUT_MS });
      } catch (e) {
        if (!(e instanceof SwarmGatewayError)) throw e;
        miss(ref);
        return null;
      }
      const t = open(bytes && { body: bytes });
      if (t) remember(ref, t);
      else miss(ref);
      return t;
    },

    copy(siegeId) {
      return open(uploadRow(siegeId));
    },

    async tick(at = now()) {
      touchWorker(at);
      const out: UploadPass = { uploaded: [], refreshed: [], errors: [] };
      let failures = 0;
      const gaveUp = () => {
        if (failures < PASS_FAILURE_LIMIT) return false;
        out.errors.push(`${failures} failures in a row: the gateway is not answering, stopping this pass`);
        return true;
      };
      for (const row of pendingUploads(at)) {
        if (gaveUp()) return out;
        try {
          out.uploaded.push({ siegeId: row.siegeId, ref: await send(row.siegeId, row.body, UPLOAD_TIMEOUT_MS) });
          failures = 0;
        } catch (e) {
          failures += 1;
          markFailed(row.siegeId, short(e), at);
          out.errors.push(`${row.siegeId}: ${short(e)}`);
        }
      }
      for (const row of staleUploads(at - KEEP_ALIVE_MS, at - KEEP_ALIVE_HORIZON_MS, at)) {
        if (gaveUp()) return out;
        try {
          out.refreshed.push({ siegeId: row.siegeId, ref: await send(row.siegeId, row.body, UPLOAD_TIMEOUT_MS), was: row.ref! });
          failures = 0;
        } catch (e) {
          failures += 1;
          markFailed(row.siegeId, `keep-alive ${short(e)}`, at);
          out.errors.push(`${row.siegeId}: keep-alive ${short(e)}`);
        }
      }
      return out;
    },
  };
}
