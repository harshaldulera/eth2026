import { and, eq } from "drizzle-orm";
import type { FreeReceipt, PaidReceipt, PaymentReceipt } from "@/lib/types";
import { db, schema, type ReceiptState } from "@/lib/db";
import { newId, nowIso } from "@/lib/util/ids";
import { asset } from "./asset";

type ReceiptRow = typeof schema.paymentReceipts.$inferSelect;
const R = schema.paymentReceipts;

/** A gate receipt may carry the id of the row the gate already claimed for it. */
export type ReceiptInput = (Omit<PaidReceipt, "siegeId"> | Omit<FreeReceipt, "siegeId">) & { receiptId?: string };

/** The same settled x402 transaction was already used for a siege (replayed PAYMENT-SIGNATURE). */
export class DuplicatePaymentError extends Error {
  constructor(readonly txId: string) {
    super(`payment ${txId} was already used`);
    this.name = "DuplicatePaymentError";
  }
}

const isUnique = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);

/**
 * Store a gate / free receipt before the siege exists. Returns the receipt row id.
 * A paid, non-stub receipt's tx id is unique: a second receipt for the same settled transaction
 * throws DuplicatePaymentError (the route answers 409 payment_already_used).
 * When the gate already claimed a row for this payment (`receiptId`), that row is reused.
 */
export function persistReceipt(receipt: ReceiptInput, opts: { state?: ReceiptState; note?: string } = {}): string {
  if (receipt.receiptId) {
    const row = getReceiptRow(receipt.receiptId);
    if (row) {
      if (opts.state || opts.note) db().update(R).set({ ...(opts.state ? { state: opts.state } : {}), ...(opts.note ? { note: opts.note } : {}) }).where(eq(R.id, row.id)).run();
      return row.id;
    }
  }
  const id = newId("rcpt");
  const base = { id, payer: receipt.payer, createdAt: nowIso(), state: opts.state ?? ("settled" as const), note: opts.note ?? null };
  if (receipt.free) {
    db()
      .insert(R)
      .values({ ...base, free: true, amountTinybar: 0, asset: asset().id, stub: false })
      .run();
  } else {
    try {
      db()
        .insert(R)
        .values({
          ...base,
          free: false,
          amountTinybar: Number(receipt.amount),
          asset: receipt.asset,
          txId: receipt.txId,
          network: receipt.network,
          hashscanUrl: receipt.hashscanUrl,
          stub: receipt.stub ?? false,
        })
        .run();
    } catch (e) {
      if (isUnique(e)) throw new DuplicatePaymentError(receipt.txId);
      throw e;
    }
  }
  return id;
}

// ─── Claims: one x402 payload, one siege ────────────────────────────────────

/**
 * Claim a payment's Hedera transaction id BEFORE verify/settle, so a PAYMENT-SIGNATURE replayed
 * concurrently is refused up front (the unique tx_id index makes the claim atomic).
 */
export function claimPayment(i: { txId: string; amount: string; asset: string; network: string; hashscanUrl: string }):
  | { ok: true; id: string }
  | { ok: false; state: ReceiptState | "unknown" } {
  const id = newId("rcpt");
  try {
    db()
      .insert(R)
      .values({
        id,
        payer: "pending",
        amountTinybar: Number(i.amount),
        asset: i.asset,
        txId: i.txId,
        network: i.network,
        hashscanUrl: i.hashscanUrl,
        free: false,
        stub: false,
        state: "claimed",
        createdAt: nowIso(),
      })
      .run();
    return { ok: true, id };
  } catch (e) {
    if (!isUnique(e)) throw e;
    const existing = db().select({ state: R.state }).from(R).where(eq(R.txId, i.txId)).get();
    return { ok: false, state: existing?.state ?? "unknown" };
  }
}

/** The payment definitely did not move money: drop the claim so a fresh payload can be tried. */
export function releaseClaim(id: string): void {
  db().delete(R).where(and(eq(R.id, id), eq(R.state, "claimed"))).run();
}

/** Settled: fill in the facts from the facilitator's settle response. */
export function finalizeClaim(id: string, i: { txId: string; payer: string; network: string; hashscanUrl: string }): void {
  db().update(R).set({ state: "settled", txId: i.txId, payer: i.payer, network: i.network, hashscanUrl: i.hashscanUrl }).where(eq(R.id, id)).run();
}

/** Settle was ambiguous: the worker resolves it on the mirror node (refund if it landed). */
export function markPendingSettlement(id: string, i: { payer?: string; note: string }): void {
  db()
    .update(R)
    .set({ state: "pending_settlement", note: i.note.slice(0, 500), ...(i.payer ? { payer: i.payer } : {}) })
    .where(eq(R.id, id))
    .run();
}

/**
 * Money moved but no siege can use it (castle closed under it, start failed, settled too late):
 * the worker refunds it. Free and stub receipts are fine to mark too (stub refunds are stub txs).
 */
export function markRefundDue(receiptId: string, note: string): boolean {
  const res = db()
    .update(R)
    .set({ state: "refund_due", note: note.slice(0, 500) })
    .where(and(eq(R.id, receiptId), eq(R.free, false), eq(R.state, "settled")))
    .run();
  return res.changes > 0;
}

/** Link a stored receipt to its siege (also fills sieges.receipt_id when that row has none yet). */
export function attachReceipt(receiptId: string, siegeId: string): void {
  db().transaction((tx) => {
    tx.update(schema.paymentReceipts).set({ siegeId }).where(eq(schema.paymentReceipts.id, receiptId)).run();
    const s = tx.select({ receiptId: schema.sieges.receiptId }).from(schema.sieges).where(eq(schema.sieges.id, siegeId)).get();
    if (s && !s.receiptId) tx.update(schema.sieges).set({ receiptId }).where(eq(schema.sieges.id, siegeId)).run();
  });
}

export function receiptFromRow(row: ReceiptRow, siegeId: string): PaymentReceipt {
  if (row.free) return { siegeId, free: true, payer: row.payer };
  return {
    siegeId,
    free: false,
    txId: row.txId ?? "",
    payer: row.payer,
    amount: String(row.amountTinybar),
    asset: row.asset,
    network: row.network ?? "",
    hashscanUrl: row.hashscanUrl ?? "",
    ...(row.stub ? { stub: true } : {}),
  };
}

export function getReceiptRow(receiptId: string): ReceiptRow | null {
  return db().select().from(R).where(eq(R.id, receiptId)).get() ?? null;
}

/** The receipt for a siege, by receipt.siege_id or by sieges.receipt_id. */
export function receiptForSiege(siegeId: string): PaymentReceipt | null {
  const t = schema.paymentReceipts;
  let row = db().select().from(t).where(eq(t.siegeId, siegeId)).get();
  if (!row) {
    const s = db().select({ receiptId: schema.sieges.receiptId }).from(schema.sieges).where(eq(schema.sieges.id, siegeId)).get();
    if (s?.receiptId) row = db().select().from(t).where(eq(t.id, s.receiptId)).get();
  }
  return row ? receiptFromRow(row, siegeId) : null;
}
