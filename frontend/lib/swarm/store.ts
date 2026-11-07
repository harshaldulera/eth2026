/**
 * What the live port remembers in SQLite (next to swarm_refs, see ./refs.ts): one row per sealed
 * transcript, with the exact bytes that went (or should go) to Swarm, and a heartbeat from the
 * worker that retries them.
 *
 *   ref NULL          the upload has not landed; worker/swarm.ts retries it with backoff
 *   uploaded_at       last successful upload; the worker re-uploads after KEEP_ALIVE_MS, because
 *                     the public gateway's stamps last about a day (see arkiv/swarm.md). The same
 *                     bytes give the same reference, so the entity's swarmRef never changes.
 *   tried_at/attempts backoff for both retries and keep-alive re-uploads (1, 2, 4 … min, up to 1 h)
 *   format            how `ref` was uploaded: "file" (transcript.json via /bzz, opens in a browser)
 *                     or "bytes" (raw, from before transcripts were named; downloads as a file).
 *                     A "bytes" row is due for re-upload right away: the worker moves it to "file".
 */
import { rawSqlite } from "@/lib/db/raw";

export type UploadFormat = "file" | "bytes";

const DDL = `
  CREATE TABLE IF NOT EXISTS swarm_uploads (
    siege_id TEXT PRIMARY KEY, body BLOB NOT NULL, transcript_hash TEXT NOT NULL, ref TEXT,
    created_at INTEGER NOT NULL, uploaded_at INTEGER, tried_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
    needs_reupload INTEGER NOT NULL DEFAULT 0, format TEXT NOT NULL DEFAULT 'bytes');
  CREATE TABLE IF NOT EXISTS swarm_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);`;
const checked = new WeakSet<object>();
function sql() {
  const s = rawSqlite(DDL);
  if (!checked.has(s)) {
    // A dev database from before these columns existed (this branch only): add them. Rows that
    // already have a reference were uploaded as raw bytes, which is what format's default says.
    const cols = s.prepare("PRAGMA table_info(swarm_uploads)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "needs_reupload")) s.exec("ALTER TABLE swarm_uploads ADD COLUMN needs_reupload INTEGER NOT NULL DEFAULT 0");
    if (!cols.some((c) => c.name === "format")) s.exec("ALTER TABLE swarm_uploads ADD COLUMN format TEXT NOT NULL DEFAULT 'bytes'");
    checked.add(s);
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
  /** A replay found Swarm not answering for the reference: re-upload in the next pass, whatever the schedule. */
  needsReupload: boolean;
  format: UploadFormat;
};

type Raw = {
  siege_id: string;
  body: Buffer;
  transcript_hash: string;
  ref: string | null;
  created_at: number;
  uploaded_at: number | null;
  tried_at: number | null;
  attempts: number;
  last_error: string | null;
  needs_reupload: number;
  format: string;
};
const asFormat = (f: string): UploadFormat => (f === "file" ? "file" : "bytes");
const fromRaw = (r: Raw): UploadRow => ({
  format: asFormat(r.format),
  siegeId: r.siege_id,
  body: new Uint8Array(r.body),
  transcriptHash: r.transcript_hash,
  ref: r.ref,
  createdAt: r.created_at,
  uploadedAt: r.uploaded_at,
  triedAt: r.tried_at,
  attempts: r.attempts,
  lastError: r.last_error,
  needsReupload: r.needs_reupload === 1,
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

/** Every upload from now on is a named file (lib/swarm/gateway.ts); `format` exists for the rows from before. */
export function markUploaded(siegeId: string, ref: string, now = Date.now()): void {
  sql()
    .prepare("UPDATE swarm_uploads SET ref = ?, uploaded_at = ?, tried_at = ?, attempts = 0, last_error = NULL, needs_reupload = 0, format = 'file' WHERE siege_id = ?")
    .run(ref, now, now, siegeId);
}

export function markFailed(siegeId: string, error: string, now = Date.now()): void {
  sql().prepare("UPDATE swarm_uploads SET attempts = attempts + 1, tried_at = ?, last_error = ? WHERE siege_id = ?").run(now, error.slice(0, 300), siegeId);
}

/**
 * Swarm stopped answering for a landed reference: have the worker re-upload it in its next pass,
 * even past the week horizon. Only a flag, written once: a public page view must not reset the
 * worker's backoff, rewrite when the transcript was sealed or last uploaded, or write at all while
 * the flag is already up. Returns whether this call raised it.
 */
export function requestReupload(siegeId: string): boolean {
  const r = sql().prepare("UPDATE swarm_uploads SET needs_reupload = 1 WHERE siege_id = ? AND ref IS NOT NULL AND needs_reupload = 0").run(siegeId) as { changes: number };
  return r.changes > 0;
}

export function uploadRow(siegeId: string): UploadRow | null {
  const r = sql().prepare("SELECT * FROM swarm_uploads WHERE siege_id = ?").get(siegeId) as Raw | undefined;
  return r ? fromRaw(r) : null;
}

/** Just the reference columns: `{ ref: null }` for a sealed transcript that has not landed, null for no row. */
export function uploadRef(siegeId: string): { ref: string | null; transcriptHash: string; format: UploadFormat } | null {
  const r = sql().prepare("SELECT ref, transcript_hash, format FROM swarm_uploads WHERE siege_id = ?").get(siegeId) as
    | { ref: string | null; transcript_hash: string; format: string }
    | undefined;
  return r ? { ref: r.ref, transcriptHash: r.transcript_hash, format: asFormat(r.format) } : null;
}

/** Retry gaps after the 1st, 2nd, 3rd … failure: 1, 2, 4 … minutes, at most an hour. */
const BACKOFF_SQL = "(tried_at IS NULL OR tried_at + MIN(60000 * (1 << MIN(MAX(attempts - 1, 0), 10)), 3600000) <= ?)";

/** Rows that never landed and whose backoff has passed, oldest first. */
export function pendingUploads(now: number, limit = 20): UploadRow[] {
  return (sql().prepare(`SELECT * FROM swarm_uploads WHERE ref IS NULL AND ${BACKOFF_SQL} ORDER BY created_at ASC LIMIT ?`).all(now, limit) as Raw[]).map(fromRaw);
}

/**
 * Rows due for a re-upload, once the backoff has passed: last uploaded before `before` and created
 * after `since` (the keep-alive), flagged by a replay, or still raw bytes (moved to a named file
 * right away). The last two ignore the horizon.
 */
export function staleUploads(before: number, since: number, now: number, limit = 20): UploadRow[] {
  return (
    sql()
      .prepare(
        `SELECT * FROM swarm_uploads WHERE ref IS NOT NULL AND ((uploaded_at < ? AND created_at >= ?) OR needs_reupload = 1 OR format != 'file') AND ${BACKOFF_SQL}
         ORDER BY needs_reupload DESC, format = 'file' ASC, uploaded_at ASC LIMIT ?`,
      )
      .all(before, since, now, limit) as Raw[]
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

// ─── The worker's heartbeat ────────────────────────────────────────────────
// Which process retries uploads is a fact about the worker, not about whoever renders a replay,
// so the worker writes it down here and the replay reads it.

const WORKER_KEY = "worker_seen_at";

export function touchWorker(now = Date.now()): void {
  sql().prepare("INSERT INTO swarm_meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(WORKER_KEY, String(now));
}

/** When a live Swarm worker last made a pass; null if never. */
export function workerSeenAt(): number | null {
  const r = sql().prepare("SELECT v FROM swarm_meta WHERE k = ?").get(WORKER_KEY) as { v: string } | undefined;
  return r ? Number(r.v) : null;
}
