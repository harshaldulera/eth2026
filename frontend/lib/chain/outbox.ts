import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, max, sql } from "drizzle-orm";
import { keccak256, stringToBytes } from "viem";
import { env } from "@/lib/config/env";
import { db as sharedDb, schema, type DB } from "@/lib/db";
import type { AuditState } from "@/lib/db/schema";
import type { SiegeEvent, TransportKind } from "@/lib/types";
import { nowIso } from "@/lib/util/ids";
import { isStubRef } from "./hashscan";
import { auditCastle, auditMessage, auditType } from "./settle";

/**
 * The HCS audit outbox: every castle's topic gets its messages in the order they happened.
 *
 * Why: audits used to be submitted inline and fire-and-forget from two processes (Next routes and the
 * worker), so concurrent submits raced and the topic read siege.message(t1), siege.message(t2),
 * siege.end, siege.message(t3), vault.release. A replay walking the topic must see the real order.
 *
 * How (the same shape as the Arkiv outbox):
 *  1. Writers only append. `chain.audit(event)` inserts an audit_log row with the next per-topic
 *     `local_seq` and state "pending" inside one IMMEDIATE transaction (SQLite serialises writers across
 *     processes), and returns `{ ok: true, topicId, seq: <local seq> }` — "queued", not yet on HCS.
 *  2. siege.start / siege.message / siege.end are not audited by callers: they are derived from the
 *     persisted `events` rows the siege engine emits (start, message…, end), in events.id order, so the
 *     final turn's siege.message always precedes siege.end. Every append first catches up on those
 *     events in the same transaction, so a worker append (siege.attempt, vault.release, vault.state)
 *     always lands after the siege.end it follows.
 *  3. One drainer (the worker's audit loop, `drainAudit`) submits each topic's rows strictly in
 *     `local_seq` order: it awaits each receipt before sending the next, and on any failure stops that
 *     topic for this pass and retries it on the next one. Rows are never reordered or skipped. Each
 *     topic drains in its own loop with its own in-process guard, and a pass waits at most
 *     `waitMs` for them, so a failing OR slow topic (a submit hanging until the SDK timeout) does not
 *     hold up another: the next pass starts the other topics again while the slow one finishes.
 *  4. A submit carries a tx id generated (and stored, state "submitting") before it is sent. If its
 *     outcome is unknown (timeout, crash, another drainer mid-send), the next pass asks the mirror node
 *     what happened to that tx id before sending anything else, so an in-doubt message is neither lost
 *     nor sent twice.
 *
 * Run ONE worker per database. A second drainer is safe on testnet (claim CAS + mirror lookup) and
 * waits in stub mode (a row "submitting" for under STUB_IN_FLIGHT_MS counts as in flight), but there is
 * no reason to run two.
 *
 * Rows written by a pre-outbox process (old column list: no local_seq, state defaulted to "pending")
 * are repaired at the start of every pass: they were submitted inline by that process, so they become
 * "submitted" (HCS seq set) or "skipped" (no seq), and never block their topic. Stop any pre-outbox
 * worker before a new-code process opens the database: it also submits inline, out of order.
 *
 * Stub mode drains through the same loop with a stub HCS (seq = the topic's next number, no network).
 */

export type AuditMode = "stub" | "testnet";
export type AuditResult = { ok: true; topicId: string; seq: number } | { ok: false; reason: string };

const L = schema.auditLog;
const E = schema.events;
const META = schema.auditMeta;

type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];
type Q = DB | Tx;

/** Topic used in stub mode for a castle without an HCS topic. */
export const stubTopicId = (castleId: string) => `0.0.stub-${castleId}`;

export const EVENTS_CURSOR = "events_cursor";
/** Siege event types whose audit rows are derived from the events table. */
export const DERIVED_TYPES: ReadonlySet<string> = new Set(["start", "message", "end"]);

/** An in-doubt submit is resent only after its tx id can no longer reach consensus (120 s valid duration) and the mirror has caught up. */
export const IN_DOUBT_MS = 150_000;

const warn = (what: string, err: unknown) => console.warn(`[audit] ${what}:`, err instanceof Error ? err.message : err);
const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

// ─── Append ──────────────────────────────────────────────────────────────────

function append(q: Q, event: SiegeEvent, mode: AuditMode, eventId: number | null): AuditResult {
  const castle = auditCastle(q, event);
  if (!castle) return { ok: false, reason: "no_castle" };
  const topicId = castle.topicId ?? (mode === "stub" ? stubTopicId(castle.id) : null);
  const row = {
    castleId: castle.id,
    siegeId: event.siegeId || null,
    type: auditType(event),
    message: auditMessage(event, castle.id),
    at: nowIso(),
    eventId,
  };
  if (!topicId) {
    q.insert(L).values({ ...row, topicId: "none", state: "skipped", lastError: "no_topic" }).run();
    return { ok: false, reason: "no_topic" };
  }
  const localSeq = (q.select({ m: max(L.localSeq) }).from(L).where(eq(L.topicId, topicId)).get()?.m ?? 0) + 1;
  q.insert(L).values({ ...row, topicId, localSeq, state: "pending" }).run();
  return { ok: true, topicId, seq: localSeq };
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const transportOf = (v: unknown): TransportKind | undefined => (v === "hosted" || v === "sdk" ? v : undefined);

function parse(raw: string): Record<string, unknown> {
  try {
    const p = JSON.parse(raw) as unknown;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The proxy request id of a siege turn (from its message event). */
function turnRequestId(q: Q, siegeId: string, turn: number): string | undefined {
  const ev = q
    .select({ payload: E.payload })
    .from(E)
    .where(and(eq(E.siegeId, siegeId), eq(E.type, "message"), eq(E.turn, turn)))
    .orderBy(desc(E.id))
    .get();
  return ev ? str(parse(ev.payload).requestId) : undefined;
}

/**
 * The audit event for a persisted siege event, with exactly the payload the routes used to audit
 * (ids and hashes only: the raider's text is hashed here, never copied).
 */
export function auditEventFor(q: Q, ev: typeof schema.events.$inferSelect): SiegeEvent | null {
  const p = parse(ev.payload);
  const base = { siegeId: ev.siegeId, castleId: ev.castleId ?? undefined, transport: transportOf(p.transport), at: ev.at };
  const turn = typeof ev.turn === "number" ? ev.turn : undefined;
  if (ev.type === "start") {
    // siege.start {txId of the x402 settlement}: free sieges have none.
    const receipt = (p.receipt ?? null) as { txId?: unknown; free?: unknown } | null;
    let txId = p.free !== true && receipt && receipt.free !== true ? str(receipt.txId) : undefined;
    if (!txId && p.free !== true && ev.siegeId) {
      const R = schema.paymentReceipts;
      txId = q.select({ t: R.txId }).from(R).where(and(eq(R.siegeId, ev.siegeId), eq(R.free, false))).get()?.t ?? undefined;
    }
    return { ...base, type: "start", payload: txId ? { txId } : {} };
  }
  if (ev.type === "message") {
    // siege.message {turn, hash of the raider's message, proxy request id, transport} (plan A4).
    if (p.role !== undefined && p.role !== "raider") return null;
    let text = typeof p.text === "string" ? p.text : undefined;
    if (text === undefined && turn !== undefined) {
      const M = schema.messages;
      text = q
        .select({ t: M.text })
        .from(M)
        .where(and(eq(M.siegeId, ev.siegeId), eq(M.turn, turn), eq(M.role, "raider")))
        .orderBy(desc(M.id))
        .get()?.t;
    }
    const requestId = str(p.requestId);
    return {
      ...base,
      type: "message",
      turn,
      requestId,
      // stringToBytes: always the UTF-8 bytes (toBytes would hex-decode a message like "0x12").
      payload: { ...(text !== undefined ? { hash: keccak256(stringToBytes(text)) } : {}), ...(requestId ? { requestId } : {}) },
    };
  }
  if (ev.type === "end") {
    // siege.end {result, transcript hash, the final reply's request id} (plan A4).
    const requestId = str(p.requestId) ?? (turn !== undefined ? turnRequestId(q, ev.siegeId, turn) : undefined);
    return {
      ...base,
      type: "end",
      turn,
      requestId,
      payload: { result: str(p.status) ?? str(p.result), transcriptHash: str(p.transcriptHash), ...(requestId ? { requestId } : {}) },
    };
  }
  return null;
}

/**
 * Append audit rows for siege events persisted since the cursor, in events.id order. Runs inside the
 * caller's IMMEDIATE transaction. Returns how many rows it appended.
 */
function deriveFromEvents(tx: Tx, mode: AuditMode): number {
  const start = Number(tx.select({ v: META.v }).from(META).where(eq(META.k, EVENTS_CURSOR)).get()?.v ?? 0) || 0;
  let cursor = start;
  let n = 0;
  for (;;) {
    const evs = tx.select().from(E).where(gt(E.id, cursor)).orderBy(asc(E.id)).limit(500).all();
    for (const ev of evs) {
      cursor = ev.id;
      if (!DERIVED_TYPES.has(ev.type)) continue;
      try {
        const audit = auditEventFor(tx, ev);
        if (audit && append(tx, audit, mode, ev.id).ok) n++;
      } catch (err) {
        warn(`event ${ev.id} (${ev.type} ${ev.siegeId})`, err);
      }
    }
    if (evs.length < 500) break;
  }
  if (cursor !== start)
    tx.insert(META)
      .values({ k: EVENTS_CURSOR, v: String(cursor) })
      .onConflictDoUpdate({ target: META.k, set: { v: String(cursor) } })
      .run();
  return n;
}

/**
 * Queue one audit message (ChainPort.audit). Synchronous: the row exists when this returns, so two
 * calls in a row keep their order. `seq` in the result is the LOCAL per-topic sequence ("queued");
 * the HCS sequence number is filled in on the row once the drainer has submitted it.
 */
export function enqueueAudit(d: DB, event: SiegeEvent, mode: AuditMode): AuditResult {
  try {
    return d.transaction(
      (tx) => {
        deriveFromEvents(tx, mode);
        return append(tx, event, mode, null);
      },
      { behavior: "immediate" },
    );
  } catch (err) {
    return { ok: false, reason: reasonOf(err) };
  }
}

/** Turn newly persisted siege events into queued audit rows (the drainer runs this every pass). */
export function syncAuditFromEvents(d: DB, mode: AuditMode): number {
  return d.transaction((tx) => deriveFromEvents(tx, mode), { behavior: "immediate" });
}

// ─── Drain ───────────────────────────────────────────────────────────────────

export type HcsLookup = { state: "landed"; seq: number } | { state: "failed"; reason: string } | { state: "unknown" };

/** What the drainer needs from HCS. Tests pass a fake. */
export type HcsPort = {
  /** A fresh Hedera transaction id ("0.0.x@sec.nanos"), stored on the row before it is sent. */
  newTxId(): string;
  /**
   * Submit one message under `txId` and wait for its receipt. Throw an error with `inDoubt: false`
   * only when the message certainly did not reach the topic; anything else is reconciled by `lookup`.
   */
  submit(topicId: string, message: string, txId: string): Promise<{ seq: number; txId: string | null }>;
  /** What became of an earlier submit whose outcome was never seen. */
  lookup(txId: string): Promise<HcsLookup>;
};

export type DrainReport = {
  derived: number;
  /** Rows a pre-outbox writer added (no local_seq) that this pass marked submitted/skipped. */
  repaired: number;
  submitted: { topicId: string; localSeq: number; seq: number; type: string; txId: string | null }[];
  failed: { topicId: string; localSeq: number; type: string; error: string }[];
  /** Topics waiting on an in-doubt submit (outcome not on the mirror yet). */
  waiting: string[];
};

/** Which topics this mode's drainer owns: stub topics in stub mode, real ones on testnet. */
const ownsTopic = (mode: AuditMode, topicId: string) => topicId !== "none" && (mode === "stub" ? isStubRef(topicId) : !isStubRef(topicId));

/** "0.0.5@1700000000.000000001" -> its valid-start in ms (NaN when it is not a Hedera tx id). */
export function txValidStartMs(txId: string): number {
  const m = /@(\d+)\.(\d+)$/.exec(txId);
  return m ? Number(m[1]) * 1000 + Math.floor(Number(m[2]) / 1e6) : NaN;
}

/** A stub row left "submitting" for less than this may still be in another drainer's hands. */
export const STUB_IN_FLIGHT_MS = 5_000;

/** Stub HCS: the topic's next sequence number, no network. */
export function stubHcs(getDb: () => DB, now: () => number = Date.now): HcsPort {
  let n = 0;
  // pid in the nanos part: two processes never mint the same stub tx id in the same second.
  const pid = String(process.pid % 1000).padStart(3, "0");
  return {
    newTxId: () => `stub:hcs@${Math.floor(now() / 1000)}.${pid}${String(++n % 1_000_000).padStart(6, "0")}`,
    async submit(topicId) {
      const last = getDb().select({ m: max(L.seq) }).from(L).where(and(eq(L.topicId, topicId), eq(L.state, "submitted"))).get()?.m ?? 0;
      return { seq: last + 1, txId: null };
    },
    async lookup(txId) {
      // A stub submit finishes at once: a row left "submitting" was either claimed just now by another
      // drainer (wait for it) or abandoned by a crash (it never happened: send it again).
      const started = txValidStartMs(txId);
      if (Number.isFinite(started) && now() - started < STUB_IN_FLIGHT_MS) return { state: "unknown" };
      return { state: "failed", reason: "stub_not_sent" };
    },
  };
}

/** Real HCS: Hedera SDK submit + mirror-node lookup. Loaded only on testnet. */
async function testnetHcs(): Promise<HcsPort> {
  const [hcs, mirror] = await Promise.all([import("./hcs"), import("./mirror")]);
  return {
    newTxId: () => hcs.newTxId(),
    submit: (topicId, message, txId) => hcs.submit(topicId, message, { txId }),
    lookup: (txId) => mirror.topicSubmitResult(txId),
  };
}

type RowState = { id: number; state: AuditState; txId: string | null };

function markSubmitted(d: DB, id: number, seq: number, txId: string | null) {
  d.update(L).set({ state: "submitted", seq, txId, submittedAt: nowIso(), lastError: null }).where(eq(L.id, id)).run();
}

/** Mark a row as being sent under `txId`, unless another drainer changed it meanwhile. */
function claim(d: DB, row: RowState, txId: string): boolean {
  const res = d
    .update(L)
    .set({ state: "submitting", txId, attempts: sql`${L.attempts} + 1`, lastError: null })
    .where(and(eq(L.id, row.id), eq(L.state, row.state), row.txId == null ? isNull(L.txId) : eq(L.txId, row.txId)))
    .run();
  return res.changes === 1;
}

async function drainTopic(
  d: DB,
  topicId: string,
  port: HcsPort,
  maxRows: number,
  now: () => number,
  out: Pick<DrainReport, "submitted" | "failed" | "waiting">,
): Promise<void> {
  for (let i = 0; i < maxRows; i++) {
    const row = d
      .select()
      .from(L)
      .where(and(eq(L.topicId, topicId), inArray(L.state, ["pending", "submitting"]), isNotNull(L.localSeq)))
      .orderBy(asc(L.localSeq))
      .limit(1)
      .get();
    if (!row || row.localSeq == null) return;
    const localSeq = row.localSeq;
    const failed = (error: string) => out.failed.push({ topicId, localSeq, type: row.type, error });

    const current: RowState = { id: row.id, state: row.state, txId: row.txId };
    if (row.state === "submitting" && row.txId) {
      // Sent before, outcome never seen: find out before sending anything else on this topic.
      let found: HcsLookup;
      try {
        found = await port.lookup(row.txId);
      } catch (err) {
        d.update(L).set({ lastError: `lookup: ${reasonOf(err)}` }).where(eq(L.id, row.id)).run();
        failed(`lookup ${row.txId}: ${reasonOf(err)}`);
        return;
      }
      if (found.state === "landed") {
        markSubmitted(d, row.id, found.seq, row.txId);
        out.submitted.push({ topicId, localSeq, seq: found.seq, type: row.type, txId: row.txId });
        continue;
      }
      if (found.state === "unknown") {
        const started = txValidStartMs(row.txId);
        if (!Number.isFinite(started) || now() - started < IN_DOUBT_MS) {
          out.waiting.push(topicId);
          return;
        }
      }
      // It failed, or it can no longer reach consensus: send it again under a new tx id.
    }
    const txId = port.newTxId();
    if (!claim(d, current, txId)) return; // another drainer has it
    try {
      const res = await port.submit(topicId, row.message, txId);
      markSubmitted(d, row.id, res.seq, res.txId);
      out.submitted.push({ topicId, localSeq, seq: res.seq, type: row.type, txId: res.txId });
    } catch (err) {
      const inDoubt = (err as { inDoubt?: unknown }).inDoubt !== false;
      const lastError = reasonOf(err);
      // Certainly not on the topic: back to pending (same place in the order). In doubt: keep the tx id for the lookup.
      d.update(L)
        .set(inDoubt ? { lastError } : { state: "pending", txId: null, lastError })
        .where(eq(L.id, row.id))
        .run();
      failed(lastError);
      return;
    }
  }
}

/**
 * Rows a pre-outbox writer inserted with the old column list (no local_seq, state defaulted to
 * "pending"). That writer already submitted them inline, so settle them the way migration 0005 settled
 * the old rows: "submitted" when they carry an HCS seq, "skipped" otherwise. Never re-sent.
 */
export function repairLegacyRows(d: DB): number {
  return d
    .update(L)
    .set({ state: sql`CASE WHEN ${L.seq} IS NOT NULL THEN 'submitted' ELSE 'skipped' END`, lastError: sql`COALESCE(${L.lastError}, 'legacy_writer')` })
    .where(and(isNull(L.localSeq), inArray(L.state, ["pending", "submitting"])))
    .run().changes;
}

/** Per database: the topics being drained right now in this process, and results not yet reported. */
type DrainState = { topics: Map<string, Promise<void>>; report: Omit<DrainReport, "derived" | "repaired"> };

const g = globalThis as unknown as { __siegeAuditDrain?: Promise<DrainReport> | null; __siegeAuditTopics?: WeakMap<DB, DrainState> };
const drainStates = g.__siegeAuditTopics instanceof WeakMap ? g.__siegeAuditTopics : (g.__siegeAuditTopics = new WeakMap<DB, DrainState>());
function drainState(d: DB): DrainState {
  let st = drainStates.get(d);
  if (!st) drainStates.set(d, (st = { topics: new Map(), report: { submitted: [], failed: [], waiting: [] } }));
  return st;
}

/** How long one pass waits for its topic loops before returning (a slow topic finishes in the background). */
export const DRAIN_WAIT_MS = 5_000;

/**
 * One drain pass: repair legacy rows, derive rows from new siege events, then start a drain loop for
 * every owned topic with queued rows that is not already draining in this process (rows within a topic
 * strictly one after another, topics independent). Waits up to `waitMs` for the loops; results of a
 * loop that outlives the pass are reported by the next pass. One pass per process at a time; a
 * concurrent call shares the running pass.
 */
export function drainAudit(
  opts: { db?: () => DB; mode?: AuditMode; port?: HcsPort; maxPerTopic?: number; now?: () => number; waitMs?: number } = {},
): Promise<DrainReport> {
  if (g.__siegeAuditDrain) return g.__siegeAuditDrain;
  const run = (async (): Promise<DrainReport> => {
    const getDb = opts.db ?? sharedDb;
    const mode: AuditMode = opts.mode ?? env().CHAIN_MODE;
    const d = getDb();
    const st = drainState(d);
    const repaired = repairLegacyRows(d);
    const derived = syncAuditFromEvents(d, mode);
    const topics = d
      .selectDistinct({ t: L.topicId })
      .from(L)
      .where(and(inArray(L.state, ["pending", "submitting"]), isNotNull(L.localSeq)))
      .all()
      .map((r) => r.t)
      .filter((t) => ownsTopic(mode, t) && !st.topics.has(t));
    if (topics.length) {
      const now = opts.now ?? Date.now;
      const port = opts.port ?? (mode === "stub" ? stubHcs(getDb) : await testnetHcs());
      for (const t of topics) {
        const p = drainTopic(d, t, port, opts.maxPerTopic ?? 50, now, st.report)
          // A throw outside drainTopic's own handling (SQLITE_BUSY in a select or claim, newTxId): report it, retry next pass.
          .catch((err) => void st.report.failed.push({ topicId: t, localSeq: 0, type: "drain", error: reasonOf(err) }))
          .finally(() => st.topics.delete(t));
        st.topics.set(t, p);
      }
    }
    const running = [...st.topics.values()];
    if (running.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(running),
        new Promise<void>((r) => {
          timer = setTimeout(r, opts.waitMs ?? DRAIN_WAIT_MS);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    }
    // Take what the loops reported so far (same arrays: a loop still running keeps appending to them).
    const r = st.report;
    return { derived, repaired, submitted: r.submitted.splice(0), failed: r.failed.splice(0), waiting: r.waiting.splice(0) };
  })();
  g.__siegeAuditDrain = run;
  return run.finally(() => {
    g.__siegeAuditDrain = null;
  });
}

/** Queued (not yet submitted) audit rows per topic, for logs and health checks. */
export function auditBacklog(d: DB): { topicId: string; pending: number; oldestAt: string | null; lastError: string | null }[] {
  return d
    .select({
      topicId: L.topicId,
      pending: sql<number>`count(*)`,
      oldestAt: sql<string | null>`min(${L.at})`,
      lastError: sql<string | null>`max(${L.lastError})`,
    })
    .from(L)
    .where(inArray(L.state, ["pending", "submitting"]))
    .groupBy(L.topicId)
    .all();
}
