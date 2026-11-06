import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { SdkStatus } from "@/lib/types";

/**
 * SDK guard leases (plan §2A). The harness long-polls GET /api/guard/next with `x-siege-lease: <id>`;
 * the poll is the heartbeat (castles.last_seen_at). Newest lease wins: a lease id the castle has not
 * seen before takes over, and the lease it replaced is retired, so the old harness's next poll gets
 * 409 lease_lost. Liveness is judged on server timestamps only (never the harness's clock).
 */

const C = schema.castles;

/** A harness that has not polled for this long is offline (worker/guard.ts moves guarding → dormant). */
export const LEASE_TTL_MS = 30_000;
/** last_seen_at is rewritten at most this often while a harness keeps polling. */
export const SEEN_WRITE_MS = 10_000;
/** Retired lease ids remembered per castle (their polls get lease_lost). */
const MAX_RETIRED = 16;

/** castles.lease_meta, JSON. Server-written only: the proxy fills tools/model from the self-check call. */
export type LeaseMeta = {
  /** x-siege-sdk of the lease holder (version string, ≤64 chars). */
  sdk?: string;
  /** When the current lease first polled. */
  since?: string;
  /** Lease ids that lost to a newer one. */
  retired?: string[];
  /** Tool names the harness offered the model on its self-check call (from the proxied request). */
  tools?: string[];
  /** Model the harness used on its self-check call. */
  model?: string;
  /** Tool names the harness says it offers (POST /api/guard/reply toolsOffered). Informational only. */
  toolsOffered?: string[];
  /** Smoke op in progress: its smoke siege id and how many turns held so far. */
  smoke?: { siegeId: string; held: number };
};

export function parseLeaseMeta(raw: string | null | undefined): LeaseMeta {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as LeaseMeta) : {};
  } catch {
    return {};
  }
}

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);

/** A harness holds the lease and polled within LEASE_TTL_MS (server time). */
export function leaseLive(row: { leaseId: string | null; lastSeenAt: string | null }, now = Date.now()): boolean {
  if (!row.leaseId) return false;
  const seen = ms(row.lastSeenAt);
  return Number.isFinite(seen) && now - seen < LEASE_TTL_MS;
}

/** Well-formed lease id from the x-siege-lease header (8–128 chars of [A-Za-z0-9_-]), else null. */
export function readLeaseId(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v && /^[A-Za-z0-9_-]{8,128}$/.test(v) ? v : null;
}

/** Read-modify-write castles.lease_meta in one IMMEDIATE transaction (the proxy and the routes both write it). */
export function updateLeaseMeta(castleId: string, fn: (m: LeaseMeta) => LeaseMeta): LeaseMeta | null {
  return db().transaction(
    (tx) => {
      const row = tx.select({ m: C.leaseMeta }).from(C).where(eq(C.id, castleId)).get();
      if (!row) return null;
      const next = fn(parseLeaseMeta(row.m));
      tx.update(C).set({ leaseMeta: JSON.stringify(next) }).where(eq(C.id, castleId)).run();
      return next;
    },
    { behavior: "immediate" },
  );
}

export type LeaseResult =
  | { ok: true; status: "same"; leaseId: string }
  /** A new lease took over (`previous` is the lease it retired, or null for the first harness). */
  | { ok: true; status: "new"; leaseId: string; previous: string | null }
  | { ok: false; reason: "lease_lost" | "not_found" };

/**
 * Claim or refresh the castle's lease for `leaseId` and write the heartbeat.
 * - the current lease → "same" (last_seen_at rewritten when older than SEEN_WRITE_MS, or `force`);
 * - a retired lease → lease_lost;
 * - any other id → "new": it takes over, the old lease is retired, lease_meta starts fresh
 *   ({sdk, since, retired}), and self_check_at / smoke_result are cleared so the new harness re-runs
 *   the self-check and the smoke op. Turns the old lease had claimed are handled by the caller
 *   (lib/guard/lifecycle onConnect).
 */
export function touchLease(castleId: string, leaseId: string, opts: { sdk?: string | null; now?: number; force?: boolean } = {}): LeaseResult {
  const now = opts.now ?? Date.now();
  const at = new Date(now).toISOString();
  return db().transaction(
    (tx): LeaseResult => {
      const row = tx.select({ leaseId: C.leaseId, leaseMeta: C.leaseMeta, lastSeenAt: C.lastSeenAt }).from(C).where(eq(C.id, castleId)).get();
      if (!row) return { ok: false, reason: "not_found" };
      if (row.leaseId === leaseId) {
        const seen = ms(row.lastSeenAt);
        if (opts.force || !Number.isFinite(seen) || now - seen >= SEEN_WRITE_MS) tx.update(C).set({ lastSeenAt: at }).where(eq(C.id, castleId)).run();
        return { ok: true, status: "same", leaseId };
      }
      const meta = parseLeaseMeta(row.leaseMeta);
      const retired = Array.isArray(meta.retired) ? meta.retired.filter((x) => typeof x === "string") : [];
      if (retired.includes(leaseId)) return { ok: false, reason: "lease_lost" };
      const nextRetired = (row.leaseId ? [row.leaseId, ...retired] : retired).slice(0, MAX_RETIRED);
      const fresh: LeaseMeta = { since: at, retired: nextRetired };
      const sdk = opts.sdk?.trim().slice(0, 64);
      if (sdk) fresh.sdk = sdk;
      tx.update(C)
        .set({ leaseId, leaseMeta: JSON.stringify(fresh), lastSeenAt: at, selfCheckAt: null, smokeResult: null })
        .where(eq(C.id, castleId))
        .run();
      return { ok: true, status: "new", leaseId, previous: row.leaseId };
    },
    { behavior: "immediate" },
  );
}

/** The castle's current lease id (null when none). */
export function currentLease(castleId: string): string | null {
  return db().select({ l: C.leaseId }).from(C).where(eq(C.id, castleId)).get()?.l ?? null;
}

/**
 * Castle.sdk for toCastle (SDK castles only): what the plug-in strip polls. Never the lease id,
 * keys, tool lists or prompt hashes, only booleans, timestamps and the smoke progress.
 */
export function sdkStatusOf(
  row: { leaseId: string | null; lastSeenAt: string | null; selfCheckAt: string | null; smokeResult: string | null; pinnedPromptHash: string | null; leaseMeta: string | null },
  now = Date.now(),
): SdkStatus {
  const s: SdkStatus = { leaseLive: leaseLive(row, now), promptPinned: !!row.pinnedPromptHash };
  if (row.selfCheckAt) s.selfCheckAt = row.selfCheckAt;
  if (row.smokeResult) {
    try {
      const v = JSON.parse(row.smokeResult) as { ok?: unknown; at?: unknown; reason?: unknown };
      if (typeof v.ok === "boolean" && typeof v.at === "string") s.smoke = { ok: v.ok, at: v.at, ...(typeof v.reason === "string" ? { reason: v.reason } : {}) };
    } catch {}
  }
  const held = parseLeaseMeta(row.leaseMeta).smoke?.held;
  if (s.smoke?.ok) s.smokeHeld = 3;
  else if (row.selfCheckAt && typeof held === "number") s.smokeHeld = held;
  return s;
}
