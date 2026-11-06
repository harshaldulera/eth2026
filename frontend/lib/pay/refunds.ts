import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { isStub } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { txUrl } from "@/lib/chain/hashscan";
import { transactionResult } from "@/lib/chain/mirror";
import type { TxRef } from "@/lib/types";
import { nowIso } from "@/lib/util/ids";

/**
 * Money that moved without buying a siege it could finish, and how it goes back.
 *
 *   voidSiege          a siege whose castle closed under it (another raider won the vault, the vault
 *                      closed/expired) can never settle on chain: mark it void, its receipt refund_due.
 *   reconcileReceipts  (worker, every pass) resolves `pending_settlement` receipts on the mirror node
 *                      (landed -> refund_due, never landed -> failed) and pays out `refund_due` ones
 *                      (operator -> payer on testnet; a stub tx in stub mode). Each refund is claimed
 *                      (`refunding`) before the transfer and is never retried automatically after a
 *                      failure (`refund_failed`), so a timeout can never refund twice.
 * Agent spend tied to a refunded / failed payment is voided, so caps count only money that stayed spent.
 */

const S = schema.sieges;
const R = schema.paymentReceipts;
const SP = schema.agentSpend;
const AG = schema.raiderAgents;

/** A pending_settlement tx id older than this that the mirror never saw cannot land any more (valid duration ≤ 180s). */
const NEVER_LANDED_MS = 10 * 60_000;
/** A gate claim normally lives for seconds; one this old belongs to a request that died mid-settle. */
const STALE_CLAIM_MS = 5 * 60_000;

type VoidOutcome = { changed: boolean; refundTinybar: number | null };

/** Void one siege inside a transaction; reports whether a paid receipt was queued for refund. */
function voidSiegeIn(tx: Pick<ReturnType<typeof db>, "select" | "update">, siegeId: string, reason: string): VoidOutcome {
  const s = tx.select().from(S).where(eq(S.id, siegeId)).get();
  if (!s || s.voidReason || s.settledAt || s.attemptTx || s.releaseTx || s.pendingTx) return { changed: false, refundTinybar: null };
  const at = nowIso();
  tx.update(S)
    .set({ voidReason: reason.slice(0, 120), settledAt: at, endedAt: s.endedAt ?? at, chainError: null })
    .where(eq(S.id, siegeId))
    .run();
  let refundTinybar: number | null = null;
  if (s.receiptId && !s.free) {
    const r = tx
      .update(R)
      .set({ state: "refund_due", note: `void: ${reason}`.slice(0, 500) })
      .where(and(eq(R.id, s.receiptId), eq(R.free, false), eq(R.state, "settled")))
      .returning({ amount: R.amountTinybar })
      .get();
    if (r) refundTinybar = r.amount;
  }
  return { changed: true, refundTinybar };
}

/** Mark a siege void (its castle closed under it). Returns true when it changed something. */
export function voidSiege(siegeId: string, reason: string): boolean {
  return db().transaction((tx) => voidSiegeIn(tx, siegeId, reason).changed);
}

export type InFlightVoid = {
  /** Every siege this call voided (paid and free). */
  voided: string[];
  /** Paid sieges whose fee is now refund_due (the worker's refund loop sends it back). */
  refunds: number;
  /** Total fees queued for refund, tinybars. */
  refundTinybar: number;
};

/**
 * The guardian is gone (vault dormant) or the vault closed: every in-flight siege on this castle is
 * voided and every paid one's receipt goes refund_due — the same path as any other void, so the
 * worker's reconcileReceipts pass pays it back. Free sieges are voided with nothing to refund.
 *   in flight     = created / in_progress (default)
 *   includeEnded  = also ended held / banished sieges the worker has not settled yet (no chain write on
 *                   record or pending): after an on-chain close their attempt can never land either.
 * A paid "broken" siege is NEVER voided here: it is a win waiting for its release. Closing a vault while
 * one is pending is refused (lib/vault/close: being_broken), so a close can never hand a raider's pot
 * back to the castellan.
 */
export function voidInFlightSieges(castleId: string, reason: string, opts: { includeEnded?: boolean } = {}): InFlightVoid {
  const statuses = opts.includeEnded
    ? (["created", "in_progress", "held", "banished"] as const)
    : (["created", "in_progress"] as const);
  return db().transaction((tx) => {
    const rows = tx
      .select({ id: S.id })
      .from(S)
      .where(and(eq(S.castleId, castleId), inArray(S.status, [...statuses]), isNull(S.voidReason), isNull(S.settledAt)))
      .all();
    const out: InFlightVoid = { voided: [], refunds: 0, refundTinybar: 0 };
    for (const r of rows) {
      const o = voidSiegeIn(tx, r.id, reason);
      if (!o.changed) continue;
      out.voided.push(r.id);
      if (o.refundTinybar != null) {
        out.refunds++;
        out.refundTinybar += o.refundTinybar;
      }
    }
    return out;
  });
}

/**
 * In-progress sieges on a castle that can no longer pay out (broken with a release on record,
 * closed, or past its deadline) are voided. Returns the ids it voided.
 */
export function voidStrandedSieges(now = Date.now()): string[] {
  const rows = db()
    .select({ id: S.id, castleId: S.castleId, status: schema.castles.status, deadline: schema.castles.deadline })
    .from(S)
    .innerJoin(schema.castles, eq(schema.castles.id, S.castleId))
    .where(and(inArray(S.status, ["created", "in_progress"]), isNull(S.voidReason)))
    .all();
  const voided: string[] = [];
  for (const r of rows) {
    const reason = r.status === "broken" ? "castle_broken" : r.status === "closed" ? "castle_closed" : r.deadline <= now ? "vault_expired" : null;
    if (reason && voidSiege(r.id, reason)) voided.push(r.id);
  }
  return voided;
}

/** A paid siege with no guardian reply this long after it started was abandoned. */
export const ABANDONED_SIEGE_MS = 30 * 60_000;

/**
 * Paid sieges that started but never got a single guardian reply (turn 0) for ABANDONED_SIEGE_MS:
 * the guardian was unavailable (a 502 gives the turn back, so the siege stays at turn 0) or the raider
 * left before playing. The fee bought nothing: void the siege and refund it. Sieges with at least one
 * guardian reply are left alone (a raider walking away mid-siege is not refunded); free sieges have
 * nothing to refund.
 */
export function voidAbandonedSieges(now = Date.now(), idleMs = ABANDONED_SIEGE_MS): string[] {
  const cutoff = new Date(now - idleMs).toISOString();
  const rows = db()
    .select({ id: S.id })
    .from(S)
    .where(and(inArray(S.status, ["created", "in_progress"]), eq(S.turn, 0), eq(S.free, false), isNull(S.voidReason), lt(S.createdAt, cutoff)))
    .all();
  return rows.map((r) => r.id).filter((id) => voidSiege(id, "no_guardian_reply"));
}

/** Agent spend that waited on (or was paid by) this receipt no longer counts once the money is back / never moved. */
function releaseSpend(receipt: typeof R.$inferSelect): void {
  db().transaction((tx) => {
    tx.update(SP).set({ state: "void" }).where(and(eq(SP.receiptId, receipt.id), eq(SP.state, "reserved"))).run();
    if (!receipt.siegeId) return;
    const settled = tx.select().from(SP).where(and(eq(SP.siegeId, receipt.siegeId), eq(SP.state, "settled"))).all();
    for (const sp of settled) {
      tx.update(SP).set({ state: "void" }).where(eq(SP.id, sp.id)).run();
      tx.update(AG)
        .set({ spentTinybar: sql`max(0, ${AG.spentTinybar} - ${sp.amountTinybar})` })
        .where(eq(AG.id, sp.agentId))
        .run();
    }
  });
}

/** The refund transfer itself. Testnet: HBAR from the arena operator back to the payer. */
async function sendRefund(r: typeof R.$inferSelect): Promise<TxRef> {
  if (isStub() || r.stub) {
    const txId = `stub:refund@${Date.now()}.${r.id.slice(-6)}`;
    return { txId, hashscanUrl: txUrl(txId), stub: true };
  }
  if (r.asset !== "0.0.0") throw new Error(`automatic refunds only support HBAR (asset ${r.asset})`);
  if (!/^\d+\.\d+\.\d+$/.test(r.payer)) throw new Error(`payer ${r.payer} is not a Hedera account id`);
  const { sdk, operatorClient } = await import("./hedera");
  const { TransferTransaction, Hbar, AccountId } = await sdk();
  const client = await operatorClient();
  const operator = client.operatorAccountId;
  if (!operator) throw new Error("Hedera operator not configured");
  const resp = await new TransferTransaction()
    .addHbarTransfer(operator, Hbar.fromTinybars(String(-r.amountTinybar)))
    .addHbarTransfer(AccountId.fromString(r.payer), Hbar.fromTinybars(String(r.amountTinybar)))
    .setTransactionMemo(`siege refund ${r.id}`.slice(0, 100))
    .execute(client);
  await resp.getReceipt(client);
  const txId = resp.transactionId.toString();
  return { txId, hashscanUrl: txUrl(txId) };
}

export type ReconcileReport = { resolved: { id: string; state: string }[]; refunded: { id: string; txId: string }[]; failed: { id: string; error: string }[] };

/** One pass: resolve ambiguous settlements, then pay due refunds. Never throws. */
export async function reconcileReceipts(now = Date.now()): Promise<ReconcileReport> {
  const report: ReconcileReport = { resolved: [], refunded: [], failed: [] };

  // Ambiguous settlements, plus claims a crashed request left behind (claimed but never finished).
  const staleClaim = new Date(now - STALE_CLAIM_MS).toISOString();
  const unresolved = db()
    .select()
    .from(R)
    .where(or(eq(R.state, "pending_settlement"), and(eq(R.state, "claimed"), lt(R.createdAt, staleClaim))))
    .limit(20)
    .all();
  for (const p of unresolved) {
    if (p.stub || !p.txId) {
      db().update(R).set({ state: "failed", note: "no transaction to resolve" }).where(eq(R.id, p.id)).run();
      releaseSpend(p);
      report.resolved.push({ id: p.id, state: "failed" });
      continue;
    }
    let res: Awaited<ReturnType<typeof transactionResult>>;
    try {
      res = await transactionResult(p.txId);
    } catch {
      continue; // mirror down: try next pass
    }
    if (res.state === "success") {
      const next = p.siegeId ? "settled" : "refund_due";
      db().update(R).set({ state: next, note: `settled late on Hedera (${p.note ?? "ambiguous settle"})`.slice(0, 500) }).where(eq(R.id, p.id)).run();
      report.resolved.push({ id: p.id, state: next });
    } else if (res.state === "failed" || now - Date.parse(p.createdAt) > NEVER_LANDED_MS) {
      const note = res.state === "failed" ? `payment failed on Hedera: ${res.result}` : "payment never reached consensus";
      db().update(R).set({ state: "failed", note }).where(eq(R.id, p.id)).run();
      releaseSpend(p);
      report.resolved.push({ id: p.id, state: "failed" });
    }
  }

  for (const r of db().select().from(R).where(eq(R.state, "refund_due")).limit(10).all()) {
    // Claim first: a crash or timeout mid-transfer leaves it `refunding`, never refunded twice.
    const claimed = db().update(R).set({ state: "refunding" }).where(and(eq(R.id, r.id), eq(R.state, "refund_due"))).run();
    if (claimed.changes !== 1) continue;
    try {
      const tx = await sendRefund(r);
      db().update(R).set({ state: "refunded", refundTx: tx.txId }).where(eq(R.id, r.id)).run();
      releaseSpend(r);
      report.refunded.push({ id: r.id, txId: tx.txId });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      db().update(R).set({ state: "refund_failed", note: `refund failed: ${error}`.slice(0, 500) }).where(eq(R.id, r.id)).run();
      report.failed.push({ id: r.id, error });
    }
  }
  return report;
}
