import type { PayPort } from "@/lib/types";
import { gate } from "./gate";
import { claimFree } from "./free";
import { checkCaps } from "./caps";

/**
 * Lane A payments: x402 gate, free daily siege, raider-agent caps and owner approvals.
 * Server-only (DB + Hedera SDK). CHAIN_MODE=stub works with no Hedera account at all.
 */
export const pay: PayPort = { gate, claimFree, checkCaps };

export { gate } from "./gate";
export { claimFree, markFreeSiege, freeLeftToday } from "./free";
export { checkCaps, settleSpend, voidSpend, holdSpend, recordOutcome, spendSummary } from "./caps";
export { requestApproval, decideApproval, listApprovals, getApproval, approvalsForAgent, cancelPendingApprovals } from "./approvals";
export {
  persistReceipt,
  attachReceipt,
  receiptForSiege,
  getReceiptRow,
  markRefundDue,
  DuplicatePaymentError,
  type ReceiptInput,
} from "./receipts";
export { voidSiege, voidStrandedSieges, voidAbandonedSieges, voidInFlightSieges, reconcileReceipts, type InFlightVoid } from "./refunds";
export { createPayerFetch, SpendControlError, isSpendControlRefusal, type PayerCreds } from "./client";
export { STUB_PAYMENT_HEADER, stubPaymentRequired } from "./stub";
export { asset, payNetwork } from "./asset";
