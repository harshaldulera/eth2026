/**
 * Memo-matched HBAR deposits to the arena operator account (plan §0 "Deposits"). Server only.
 *
 * createIntent  -> an intent row + the memo `siege:<code>` to send from any wallet.
 * matchDeposits -> pure: which mirror transfers pay which intents (memo, payer filter, tx ids once).
 * settleIntent  -> claims awaiting|underpaid|expired -> funding atomically, runs the kind's handler once.
 * Stub mode confirms inline in createIntent, so demos and tests need no worker.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { env } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { stubTx } from "@/lib/chain/stub";
import type { AccountTransfer } from "@/lib/chain/mirror";
import type { DepositKind, DepositState } from "@/lib/db/schema";
import type { DepositStatus } from "@/lib/api/client";

export type DepositIntent = typeof schema.depositIntents.$inferSelect;
export type { DepositKind, DepositState };

const CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
/** Money arriving this long after the window still funds (with a note for a manual refund). */
export const LATE_GRACE_MS = 24 * 3_600_000;
export const MAX_HANDLER_ATTEMPTS = 5;
export const STUB_OPERATOR = "0.0.stub-arena";
export const LATE_NOTE = "late: deposit arrived after the window, refund manually if it is no longer wanted";
/** A `funding` intent claimed this long ago whose process died is moved back to `failed` (handlers are resumable). */
export const STUCK_FUNDING_MS = 10 * 60_000;

export function newCode(): string {
  const bytes = randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return s;
}

/** The arena account that receives deposits. */
export function depositAccount(): string {
  const id = env().HEDERA_OPERATOR_ID;
  if (id) return id;
  if (env().CHAIN_MODE === "stub") return STUB_OPERATOR;
  throw new Error("operator_not_configured: HEDERA_OPERATOR_ID is not set");
}

// ─── handlers ───────────────────────────────────────────────────────────────

export type DepositHandler = (intent: DepositIntent) => Promise<void>;
const handlers = new Map<DepositKind, DepositHandler>();

/** Register what happens once a kind's deposit is confirmed (the worker and stub createIntent call it). */
export function onDepositConfirmed(kind: DepositKind, handler: DepositHandler): void {
  handlers.set(kind, handler);
}

/** Tests: forget registered handlers. */
export function resetDepositHandlers(): void {
  handlers.clear();
}

// ─── intents ────────────────────────────────────────────────────────────────

export type CreateIntentInput = {
  kind: DepositKind;
  refId: string;
  amountTinybar: bigint | number;
  payerFilter?: string | null;
  windowMin?: number;
};

export type CreatedIntent = {
  intentId: string;
  code: string;
  memo: string;
  to: string;
  /** Tinybar, decimal string. */
  amount: string;
  expiresAt: string;
  /** Final state: in stub mode the deposit is confirmed (and the handler run) before this returns. */
  state: DepositState;
};

export async function createIntent(input: CreateIntentInput): Promise<CreatedIntent> {
  const amount = Number(input.amountTinybar);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("invalid_amount");
  const to = depositAccount();
  const now = Date.now();
  const windowMs = (input.windowMin ?? env().DEPOSIT_WINDOW_MIN) * 60_000;
  const id = randomUUID();
  let code = newCode();
  for (let attempt = 0; ; attempt++) {
    try {
      db()
        .insert(schema.depositIntents)
        .values({
          id,
          kind: input.kind,
          refId: input.refId,
          code,
          memo: `siege:${code}`,
          amountTinybar: amount,
          payerFilter: input.payerFilter?.trim() || null,
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + windowMs).toISOString(),
        })
        .run();
      break;
    } catch (e) {
      if (attempt < 5 && /UNIQUE.*code/i.test(e instanceof Error ? e.message : "")) {
        code = newCode();
        continue;
      }
      throw e;
    }
  }
  let intent = getIntent(id)!;
  if (env().CHAIN_MODE === "stub") {
    const t: AccountTransfer = {
      txId: stubTx().txId,
      // A payer filter (publish form payerAccount) is honoured: the stub payer is that account.
      payer: input.payerFilter?.trim() || `0.0.stub-owner-${code}`,
      memo: intent.memo,
      amountToAccount: String(amount),
      consensusTimestamp: toConsensus(now),
    };
    const delay = env().SIEGE_STUB_DEPOSIT_DELAY_MS;
    if (delay > 0) {
      // Stub rehearsal: show WAITING FOR DEPOSIT, then confirm (a recording gets the whole beat).
      setTimeout(() => {
        const cur = getIntent(id);
        if (!cur) return;
        const [late] = matchDeposits([cur], [{ ...t, consensusTimestamp: toConsensus(Date.now()) }]);
        if (late) void settleIntent(id, late).catch(() => undefined);
      }, delay).unref?.();
    } else {
      const [m] = matchDeposits([intent], [t]);
      if (m) await settleIntent(id, m, now);
      intent = getIntent(id)!;
    }
  }
  return { intentId: id, code, memo: intent.memo, to, amount: String(amount), expiresAt: intent.expiresAt, state: intent.state };
}

export function getIntent(id: string): DepositIntent | undefined {
  return db().select().from(schema.depositIntents).where(eq(schema.depositIntents.id, id)).get();
}

const SECRET_KEY = /\b(?:ok|rk|gk|vk|mk|sk)[_-][A-Za-z0-9_-]{10,}/g;
const cleanError = (s: string | null): string | null => (s ? s.replace(SECRET_KEY, "[redacted]").slice(0, 200) : null);

/** Public status of an intent (nothing secret: the handler's error is redacted and truncated). */
export function intentStatus(intentId: string, now = Date.now()): DepositStatus | null {
  const i = getIntent(intentId);
  if (!i) return null;
  // Show `expired` as soon as the window passes, even before the worker flips the row.
  const state: DepositState = (i.state === "awaiting" || i.state === "underpaid") && Date.parse(i.expiresAt) < now ? "expired" : i.state;
  return {
    intentId: i.id,
    kind: i.kind,
    state,
    received: String(i.receivedTinybar),
    requested: String(i.amountTinybar),
    payer: i.payer,
    error: cleanError(i.error),
    note: i.note,
    expiresAt: i.expiresAt,
    deposit: { to: depositAccount(), memo: i.memo, amount: String(i.amountTinybar) },
    step: i.state === "funding" || i.state === "funded" ? parseStep(i.step) : null,
  };
}

// ─── matching (pure) ────────────────────────────────────────────────────────

export type DepositMatch = {
  intentId: string;
  /** Total counted so far (earlier transfers + the new ones), tinybar. */
  received: number;
  /** Every counted tx id. */
  txs: string[];
  payer: string | null;
  /** received >= requested. */
  enough: boolean;
  /** Some counted money landed after the window closed. */
  late: boolean;
  /** Money from accounts other than `payer` (counted toward nothing; refund by hand), or null. */
  others?: string | null;
};

type MatchableIntent = Pick<DepositIntent, "id" | "code" | "amountTinybar" | "payerFilter" | "receivedTinybar" | "txs" | "state" | "expiresAt" | "payer"> &
  Partial<Pick<DepositIntent, "note">>;

/** "other payer 0.0.666 sent 1 tinybar" entries of a note (machine-read back on the next pass). */
const OTHER_PAYER_RE = /other payer (\S+) sent (\d+) tinybar/g;
export const OTHERS_PREFIX = "refund manually:";

function othersFromNote(note: string | null | undefined): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of (note ?? "").matchAll(OTHER_PAYER_RE)) m.set(x[1]!, (m.get(x[1]!) ?? 0) + Number(x[2]));
  return m;
}

function othersNote(sums: Map<string, number>, lead: string | null): string | null {
  const parts = [...sums].filter(([p, v]) => p !== lead && v > 0).map(([p, v]) => `other payer ${p} sent ${v} tinybar`);
  return parts.length ? `${OTHERS_PREFIX} ${parts.join(", ")}` : null;
}

/** Notes joined with "; ", without the previous "refund manually: other payer …" entry (it is recomputed). */
function mergeNotes(prev: string | null | undefined, ...add: (string | null | undefined)[]): string | null {
  const kept = (prev ?? "")
    .split("; ")
    .filter((p) => p && !p.startsWith(OTHERS_PREFIX) && !add.includes(p));
  const all = [...kept, ...add.filter((x): x is string => Boolean(x))];
  return all.length ? all.join("; ").slice(0, 1000) : null;
}

/** "1793983429.213832557" -> epoch ms. */
export function consensusMs(ts: string): number {
  const [s = "0", n = "0"] = ts.split(".");
  return Number(s) * 1000 + Math.floor(Number(n.padEnd(9, "0").slice(0, 9)) / 1e6);
}
const toConsensus = (ms: number) => `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1_000_000).padStart(9, "0")}`;

function countedTxs(txs: string): string[] {
  try {
    const v = JSON.parse(txs);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Which transfers pay which open intents. Only awaiting, underpaid and expired intents match; a
 * transfer counts when its memo (trimmed, lower-cased) is `siege:<code>`, the payer passes the
 * intent's filter, its tx id was not counted before, and it landed no later than 24 h after expiry.
 * Returns one entry per intent that gained at least one new transfer.
 */
export function matchDeposits(intents: MatchableIntent[], transfers: AccountTransfer[]): DepositMatch[] {
  const out: DepositMatch[] = [];
  for (const i of intents) {
    if (i.state !== "awaiting" && i.state !== "underpaid" && i.state !== "expired") continue;
    const memo = `siege:${i.code}`;
    const seen = new Set(countedTxs(i.txs));
    const filter = i.payerFilter?.trim();
    const expires = Date.parse(i.expiresAt);
    // Per-payer sums: the intent belongs to ONE account whose own transfers pay it. Anyone else who
    // sends to the memo (e.g. 1 tinybar ahead of the real owner) is counted toward nothing and noted
    // for a manual refund, so they can never become the vault's owner or the unit's withdraw wallet.
    const sums = othersFromNote(i.note);
    if (i.payer && i.receivedTinybar > 0) sums.set(i.payer, i.receivedTinybar);
    // A row counted before payers were recorded: its sum goes to the first payer seen now.
    let unattributed = !i.payer && i.receivedTinybar > 0 ? i.receivedTinybar : 0;
    const lateBy = new Set<string>();
    let added = 0;
    for (const t of transfers) {
      if (t.memo.trim().toLowerCase() !== memo) continue;
      if (filter && t.payer !== filter) continue;
      if (seen.has(t.txId)) continue;
      const at = consensusMs(t.consensusTimestamp);
      if (at > expires + LATE_GRACE_MS) continue;
      const amt = Number(t.amountToAccount);
      if (!Number.isSafeInteger(amt) || amt <= 0) continue;
      seen.add(t.txId);
      sums.set(t.payer, (sums.get(t.payer) ?? 0) + amt + unattributed);
      unattributed = 0;
      if (at > expires) lateBy.add(t.payer);
      added++;
    }
    if (!added) continue;
    // Lead payer: the largest sum (ties keep the payer already on the intent).
    let payer: string | null = i.payer && sums.has(i.payer) ? i.payer : null;
    let received = payer ? sums.get(payer)! : 0;
    for (const [p, v] of sums) if (v > received) [payer, received] = [p, v];
    const leadTx = (tx: string) => (payer && tx.startsWith(`${payer}-`) ? 0 : 1);
    const txs = [...seen].sort((a, b) => leadTx(a) - leadTx(b));
    out.push({
      intentId: i.id,
      received,
      txs,
      payer,
      enough: received >= i.amountTinybar,
      late: payer ? lateBy.has(payer) : false,
      others: othersNote(sums, payer),
    });
  }
  return out;
}

// ─── settling ───────────────────────────────────────────────────────────────

/**
 * Apply a match. Underpaid: record what arrived. Enough: claim the intent (awaiting|underpaid|expired
 * -> funding) in one UPDATE so exactly one caller wins, run the kind's handler, then funded, or
 * failed (+error, attempts + 1) for retryFailed. A second call for the same intent is a no-op.
 */
export async function settleIntent(intentId: string, match: DepositMatch, now = Date.now()): Promise<DepositState> {
  const d = db();
  const T = schema.depositIntents;
  const prevNote = getIntent(intentId)?.note ?? null;
  const others = match.others ?? null;
  if (!match.enough) {
    d.update(T)
      .set({ state: "underpaid", receivedTinybar: match.received, txs: JSON.stringify(match.txs), payer: match.payer, note: mergeNotes(prevNote, others) })
      .where(and(eq(T.id, intentId), inArray(T.state, ["awaiting", "underpaid"])))
      .run();
    return getIntent(intentId)?.state ?? "failed";
  }
  const claimed = d
    .update(T)
    .set({
      state: "funding",
      receivedTinybar: match.received,
      txs: JSON.stringify(match.txs),
      payer: match.payer,
      note: mergeNotes(prevNote, others, match.late ? LATE_NOTE : null),
      error: null,
      claimedAt: new Date(now).toISOString(),
      step: null,
    })
    .where(and(eq(T.id, intentId), inArray(T.state, ["awaiting", "underpaid", "expired"])))
    .run();
  if (claimed.changes !== 1) return getIntent(intentId)?.state ?? "failed";
  return runHandler(intentId, now);
}

async function runHandler(intentId: string, now: number): Promise<DepositState> {
  const T = schema.depositIntents;
  const intent = getIntent(intentId)!;
  try {
    const h = handlers.get(intent.kind);
    if (!h) throw new Error(`no_handler:${intent.kind}`);
    await h(intent);
    db().update(T).set({ state: "funded", fundedAt: new Date(now).toISOString(), error: null }).where(eq(T.id, intentId)).run();
    return "funded";
  } catch (e) {
    db()
      .update(T)
      .set({ state: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 500), attempts: intent.attempts + 1 })
      .where(eq(T.id, intentId))
      .run();
    return "failed";
  }
}

/** Re-run the handler of a failed intent (attempts < MAX_HANDLER_ATTEMPTS); the claim is atomic too. */
export async function retryFailed(intentId: string, now = Date.now()): Promise<DepositState | null> {
  const T = schema.depositIntents;
  const claimed = db()
    .update(T)
    .set({ state: "funding", claimedAt: new Date(now).toISOString() })
    .where(and(eq(T.id, intentId), eq(T.state, "failed")))
    .run();
  if (claimed.changes !== 1) return null;
  return runHandler(intentId, now);
}

/** awaiting|underpaid intents past their window -> expired. Returns how many. */
export function expireIntents(now = Date.now()): number {
  const T = schema.depositIntents;
  const rows = db().select().from(T).where(inArray(T.state, ["awaiting", "underpaid"])).all();
  let n = 0;
  for (const r of rows) {
    if (Date.parse(r.expiresAt) >= now) continue;
    n += db().update(T).set({ state: "expired" }).where(and(eq(T.id, r.id), inArray(T.state, ["awaiting", "underpaid"]))).run().changes;
  }
  return n;
}

/** Intents the worker still watches: open ones, plus expired ones inside the 24 h late window. */
export function openIntents(now = Date.now()): DepositIntent[] {
  const T = schema.depositIntents;
  return db()
    .select()
    .from(T)
    .where(inArray(T.state, ["awaiting", "underpaid", "expired"]))
    .all()
    .filter((i) => i.state !== "expired" || Date.parse(i.expiresAt) + LATE_GRACE_MS >= now);
}

export function failedIntents(): DepositIntent[] {
  return db().select().from(schema.depositIntents).where(eq(schema.depositIntents.state, "failed")).all();
}

/**
 * `funding` intents claimed more than STUCK_FUNDING_MS ago (the process running the handler died):
 * back to `failed`, so retryFailed resumes them. Every handler is resumable from what already exists
 * (castle row / topic / vault, the unit's stored account key, the top-up's pre-generated tx id).
 */
export function unstickFunding(now = Date.now()): number {
  const T = schema.depositIntents;
  const rows = db().select().from(T).where(eq(T.state, "funding")).all();
  let n = 0;
  for (const r of rows) {
    const at = r.claimedAt ? Date.parse(r.claimedAt) : Date.parse(r.createdAt);
    if (!(now - at > STUCK_FUNDING_MS)) continue;
    n += db()
      .update(T)
      .set({ state: "failed", error: "handler_interrupted: the process stopped mid-setup; retrying", attempts: r.attempts + 1 })
      .where(and(eq(T.id, r.id), eq(T.state, "funding"), r.claimedAt ? eq(T.claimedAt, r.claimedAt) : eq(T.createdAt, r.createdAt)))
      .run().changes;
  }
  return n;
}

/** Append a note to an intent (refunds the operator does by hand: overpay, nothing left to fund, …). */
export function noteIntent(intentId: string, note: string): void {
  const T = schema.depositIntents;
  const prev = getIntent(intentId)?.note ?? null;
  if (prev?.split("; ").includes(note)) return;
  db()
    .update(T)
    .set({ note: prev ? `${prev}; ${note}`.slice(0, 1000) : note })
    .where(eq(T.id, intentId))
    .run();
}

/**
 * Setup progress shown by the deposit panel as SETTING UP k/n (handlers await it between steps). In a
 * stub rehearsal (SIEGE_STUB_DEPOSIT_DELAY_MS) each step is held a moment so the k/n is visible.
 */
export async function setIntentStep(intentId: string, k: number, n: number, label: string): Promise<void> {
  db()
    .update(schema.depositIntents)
    .set({ step: `${k}/${n} ${label}`.slice(0, 80) })
    .where(eq(schema.depositIntents.id, intentId))
    .run();
  const delay = env().CHAIN_MODE === "stub" ? env().SIEGE_STUB_DEPOSIT_DELAY_MS : 0;
  if (delay > 0) await new Promise((r) => setTimeout(r, Math.min(3000, Math.round(delay / 2))));
}

/** "2/3 topic" -> { k: 2, n: 3, label: "topic" }, else null. */
export function parseStep(step: string | null | undefined): { k: number; n: number; label: string } | null {
  const m = step ? /^(\d+)\/(\d+)\s*(.*)$/.exec(step) : null;
  return m ? { k: Number(m[1]), n: Number(m[2]), label: m[3] ?? "" } : null;
}
