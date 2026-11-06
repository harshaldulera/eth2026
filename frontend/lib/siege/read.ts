import { and, asc, desc, eq, isNull, type SQL } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { MAX_CHAIN_ATTEMPTS } from "@/lib/db/schema";
import type { PaymentReceipt, Siege, SiegeMessage, SiegeSettlement, SiegeStatus, TxRef } from "@/lib/types";

/**
 * Sync row → Siege mappers. Kept free of lib/chain (to avoid an import cycle while it is written):
 * the HashScan helper below mirrors lib/chain/hashscan.ts.
 */

export type SiegeRow = typeof schema.sieges.$inferSelect;
export type MessageRow = typeof schema.messages.$inferSelect;

/** "0.0.5@1.2" -> "0.0.5-1-2"; EVM hashes pass through. */
function txPath(txId: string): string {
  if (txId.startsWith("0x")) return txId;
  const [acct, ts] = txId.split("@");
  return ts ? `${acct}-${ts.replace(".", "-")}` : txId;
}

/** TxRef for a stored tx id. Stub ids ("stub:…") get stub:true and url "#stub". */
export function localTxRef(txId: string): TxRef {
  if (txId.startsWith("stub:")) return { txId, hashscanUrl: "#stub", stub: true };
  return { txId, hashscanUrl: `https://hashscan.io/testnet/transaction/${txPath(txId)}` };
}

export function siegeRow(id: string): SiegeRow | null {
  return db().select().from(schema.sieges).where(eq(schema.sieges.id, id)).get() ?? null;
}

export function messageRows(siegeId: string): MessageRow[] {
  return db()
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.siegeId, siegeId))
    .orderBy(asc(schema.messages.turn), asc(schema.messages.id))
    .all();
}

export function toSiegeMessage(m: MessageRow): SiegeMessage {
  const out: SiegeMessage = { role: m.role, text: m.text, turn: m.turn, at: m.at };
  if (m.move) out.move = m.move as SiegeMessage["move"];
  if (m.requestId) out.requestId = m.requestId;
  return out;
}

type ReceiptRow = typeof schema.paymentReceipts.$inferSelect;

function receiptRowFor(row: SiegeRow): ReceiptRow | undefined {
  const r = schema.paymentReceipts;
  return (
    (row.receiptId ? db().select().from(r).where(eq(r.id, row.receiptId)).get() : undefined) ??
    db().select().from(r).where(eq(r.siegeId, row.id)).get()
  );
}

function refundFor(rec: ReceiptRow | undefined): SiegeSettlement["refund"] {
  if (!rec || rec.free) return undefined;
  const amount = String(rec.amountTinybar);
  switch (rec.state) {
    case "refund_due":
    case "refunding":
      return { state: "due", amount };
    case "refunded":
      return { state: "refunded", amount, ...(rec.refundTx ? { tx: localTxRef(rec.refundTx) } : {}) };
    case "refund_failed":
      return { state: "failed", amount };
    default:
      return undefined;
  }
}

/** Where the worker is with this siege's money (see SiegeSettlement). */
export function settlementFor(row: SiegeRow, rec: ReceiptRow | undefined = receiptRowFor(row)): SiegeSettlement | undefined {
  const refund = refundFor(rec);
  if (row.voidReason) return { state: "void", reason: row.voidReason, ...(refund ? { refund } : {}) };
  if (row.status === "created" || row.status === "in_progress") return undefined;
  if (row.settledAt) return { state: "settled", ...(refund ? { refund } : {}) };
  if (row.chainAttempts >= MAX_CHAIN_ATTEMPTS) return { state: "failed", reason: row.chainError ?? "unknown", ...(refund ? { refund } : {}) };
  return { state: "pending", ...(row.chainError ? { reason: row.chainError } : {}) };
}

function receiptFor(row: SiegeRow, rec: ReceiptRow | undefined = receiptRowFor(row)): PaymentReceipt | undefined {
  if (!rec) return row.free ? { siegeId: row.id, free: true, payer: row.raider } : undefined;
  if (rec.free) return { siegeId: row.id, free: true, payer: rec.payer };
  const txId = rec.txId ?? "";
  const out: PaymentReceipt = {
    siegeId: row.id,
    free: false,
    txId,
    payer: rec.payer,
    amount: String(rec.amountTinybar),
    asset: rec.asset,
    network: rec.network ?? "hedera:testnet",
    hashscanUrl: rec.hashscanUrl ?? (txId ? localTxRef(txId).hashscanUrl : "#stub"),
  };
  if (rec.stub) out.stub = true;
  return out;
}

export function toSiege(row: SiegeRow, msgs: MessageRow[] = messageRows(row.id)): Siege {
  const s: Siege = {
    id: row.id,
    castleId: row.castleId,
    raider: row.raider,
    turn: row.turn,
    status: row.status,
    messages: msgs.map(toSiegeMessage),
    free: row.free,
    createdAt: row.createdAt,
  };
  if (row.agentId) s.agentId = row.agentId;
  const rec = receiptRowFor(row);
  const receipt = receiptFor(row, rec);
  if (receipt) s.receipt = receipt;
  const settlement = settlementFor(row, rec);
  if (settlement) s.settlement = settlement;
  if (row.transcriptHash) s.transcriptHash = row.transcriptHash as `0x${string}`;
  if (row.attemptTx) s.attempt = localTxRef(row.attemptTx);
  if (row.releaseTx) s.release = { ...localTxRef(row.releaseTx), amount: String(row.releaseAmountTinybar ?? 0) };
  if (row.endedAt) s.endedAt = row.endedAt;
  return s;
}

export function getSiege(id: string): Siege | null {
  const row = siegeRow(id);
  return row ? toSiege(row) : null;
}

/** Newest first. `status` is an extension used by Arkiv's liveSieges. */
export function listSieges(f: { castleId?: string; agentId?: string; status?: SiegeStatus; limit?: number } = {}): Siege[] {
  const s = schema.sieges;
  const where: SQL[] = [];
  if (f.castleId) where.push(eq(s.castleId, f.castleId));
  if (f.agentId) where.push(eq(s.agentId, f.agentId));
  if (f.status) where.push(eq(s.status, f.status));
  // A voided siege is over even though its castle closed before it could end on its own.
  if (f.status === "in_progress" || f.status === "created") where.push(isNull(s.voidReason));
  return db()
    .select()
    .from(s)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(s.createdAt), desc(s.id))
    .limit(f.limit ?? 50)
    .all()
    .map((row) => toSiege(row));
}
