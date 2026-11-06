/**
 * What the live port remembers in SQLite (next to swarm_refs, see ./refs.ts): one row per sealed
 * transcript, with the exact bytes that went (or should go) to Swarm.
 *
 *   ref NULL          the upload has not landed; worker/swarm.ts retries it with backoff
 *   uploaded_at       last successful upload; the worker re-uploads after KEEP_ALIVE_MS, because
 *                     the public gateway's stamps last about a day (see arkiv/swarm.md). The same
 *                     bytes give the same reference, so the entity's swarmRef never changes.
 */
import { db } from "@/lib/db";

type Sqlite = { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } };
const ready = new WeakSet<object>();

function sql(): Sqlite {
  const s = (db() as unknown as { $client: Sqlite }).$client;
  if (!ready.has(s)) {
    s.exec(`CREATE TABLE IF NOT EXISTS swarm_uploads (
      siege_id TEXT PRIMARY KEY, body BLOB NOT NULL, transcript_hash TEXT NOT NULL, ref TEXT,
      created_at INTEGER NOT NULL, uploaded_at INTEGER, tried_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT)`);
    ready.add(s);
  }
  return s;
}

export type UploadRow = {
  siegeId: string;
  body: Uint8Array;
  transcriptHash: string;
  ref: string | null;
  createdAt: number;
  uploadedAt: number | null;
  triedAt: number | null;
  attempts: number;
  lastError: string | null;
};

type Raw = { siege_id: string; body: Buffer; transcript_hash: string; ref: string | null; created_at: number; uploaded_at: number | null; tried_at: number | null; attempts: number; last_error: string | null };
const fromRaw = (r: Raw): UploadRow => ({
  siegeId: r.siege_id,
  body: new Uint8Array(r.body),
  transcriptHash: r.transcript_hash,
  ref: r.ref,
  createdAt: r.created_at,
  uploadedAt: r.uploaded_at,
  triedAt: r.tried_at,
  attempts: r.attempts,
  lastError: r.last_error,
});

/** Remember the sealed bytes for a siege. A different transcript for the same siege starts over; the same one keeps its reference. */
export function rememberUpload(siegeId: string, body: Uint8Array, transcriptHash: string, now = Date.now()): void {
  sql()
    .prepare(
      `INSERT INTO swarm_uploads (siege_id, body, transcript_hash, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (siege_id) DO UPDATE SET body = excluded.body, created_at = excluded.created_at,
         ref = CASE WHEN swarm_uploads.transcript_hash = excluded.transcript_hash THEN swarm_uploads.ref ELSE NULL END,
         uploaded_at = CASE WHEN swarm_uploads.transcript_hash = excluded.transcript_hash THEN swarm_uploads.uploaded_at ELSE NULL END,
         transcript_hash = excluded.transcript_hash, tried_at = NULL, attempts = 0, last_error = NULL`,
    )
    .run(siegeId, Buffer.from(body), transcriptHash.toLowerCase(), now);
}

export function markUploaded(siegeId: string, ref: string, now = Date.now()): void {
  sql().prepare("UPDATE swarm_uploads SET ref = ?, uploaded_at = ?, tried_at = ?, attempts = 0, last_error = NULL WHERE siege_id = ?").run(ref, now, now, siegeId);
}

export function markFailed(siegeId: string, error: string, now = Date.now()): void {
  sql().prepare("UPDATE swarm_uploads SET attempts = attempts + 1, tried_at = ?, last_error = ? WHERE siege_id = ?").run(now, error.slice(0, 300), siegeId);
}

export function uploadRow(siegeId: string): UploadRow | null {
  const r = sql().prepare("SELECT * FROM swarm_uploads WHERE siege_id = ?").get(siegeId) as Raw | undefined;
  return r ? fromRaw(r) : null;
}

/** Retry gaps after the 1st, 2nd, 3rd … failure: 1, 2, 4 … minutes, at most an hour. */
const BACKOFF_SQL = "MIN(60000 * (1 << MIN(MAX(attempts - 1, 0), 10)), 3600000)";

/** Rows that never landed and whose backoff has passed, oldest first. */
export function pendingUploads(now: number, limit = 20): UploadRow[] {
  return (
    sql()
      .prepare(`SELECT * FROM swarm_uploads WHERE ref IS NULL AND (tried_at IS NULL OR tried_at + ${BACKOFF_SQL} <= ?) ORDER BY created_at ASC LIMIT ?`)
      .all(now, limit) as Raw[]
  ).map(fromRaw);
}

/** Rows last uploaded before `before` (and created after `since`): due for a keep-alive re-upload. */
export function staleUploads(before: number, since: number, limit = 20): UploadRow[] {
  return (
    sql()
      .prepare("SELECT * FROM swarm_uploads WHERE ref IS NOT NULL AND uploaded_at < ? AND created_at >= ? ORDER BY uploaded_at ASC LIMIT ?")
      .all(before, since, limit) as Raw[]
  ).map(fromRaw);
}

export function uploadStats(now = Date.now()): { total: number; pending: number; failing: number; oldestUploadMs: number | null } {
  const r = sql().prepare("SELECT COUNT(*) AS n, SUM(ref IS NULL) AS p, SUM(attempts > 0) AS f, MIN(uploaded_at) AS o FROM swarm_uploads").get() as {
    n: number;
    p: number | null;
    f: number | null;
    o: number | null;
  };
  return { total: r.n, pending: r.p ?? 0, failing: r.f ?? 0, oldestUploadMs: r.o == null ? null : now - r.o };
}
