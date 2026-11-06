"use client";

import { useState } from "react";
import { ChevronDown, Gift, Receipt } from "lucide-react";
import type { Asset, FreeReceipt, PaidReceipt, PaymentReceipt } from "@/lib/types";
import { HBAR } from "@/lib/money/format";
import { cn } from "@/lib/utils";
import { Amount } from "./amount";
import { HashscanLink } from "./hashscan-link";

type AnyReceipt = PaymentReceipt | Omit<PaidReceipt, "siegeId"> | Omit<FreeReceipt, "siegeId">;

/** Asset for a receipt's asset id (HBAR "0.0.0"; testnet USDC "0.0.429274"). */
export function receiptAsset(assetId: string | undefined, fallback?: Asset): Asset {
  if (fallback && fallback.id === assetId) return fallback;
  if (!assetId || assetId === "0.0.0") return HBAR;
  if (assetId === "0.0.429274") return { id: assetId, decimals: 6, symbol: "USDC" };
  return fallback ?? HBAR;
}

export type PaymentReceiptCardProps = {
  receipt: AnyReceipt;
  castleName?: string;
  asset?: Asset;
  /** Render as a one-line chip that expands on click (siege room header). */
  compact?: boolean;
  className?: string;
};

/**
 * Proof that the siege fee was paid via x402 on Hedera (or that it is a free practice siege).
 *
 * @example <PaymentReceiptCard receipt={siege.receipt} castleName={castle.name} />
 * @example <PaymentReceiptCard receipt={siege.receipt} compact />
 */
export function PaymentReceiptCard({ receipt, castleName, asset, compact, className }: PaymentReceiptCardProps) {
  const [open, setOpen] = useState(false);

  if (receipt.free) {
    return (
      <div
        className={cn(
          "flex items-center gap-2.5 rounded-xl border border-dashed border-parchment/20 bg-parchment/[0.03] px-3 py-2 text-sm",
          className,
        )}
      >
        <Gift className="size-4 shrink-0 text-parchment/70" aria-hidden />
        <div className="min-w-0">
          <p className="text-parchment">Free daily siege</p>
          {!compact ? (
            <p className="text-xs text-stone">Practice, can&apos;t win the pot · wallet {receipt.payer}</p>
          ) : (
            <p className="text-xs text-stone">Practice — can&apos;t win the pot</p>
          )}
        </div>
      </div>
    );
  }

  const a = receiptAsset(receipt.asset, asset);
  const paidTx = { txId: receipt.txId, hashscanUrl: receipt.hashscanUrl, stub: receipt.stub };

  if (compact && !open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={false}
        className={cn(
          "inline-flex max-w-full items-center gap-2 rounded-full border border-gold/25 bg-gold/[0.06] py-1 pr-2.5 pl-2 text-xs text-parchment/90 transition-colors hover:border-gold/50",
          className,
        )}
      >
        <Receipt className="size-3.5 text-gold" aria-hidden />
        <span>
          Paid <Amount amount={receipt.amount} asset={a} size="xs" animate={false} /> via x402
        </span>
        {receipt.stub ? <span className="rounded border border-dashed border-stone/50 px-1 text-[10px] text-stone">stub</span> : null}
        <ChevronDown className="size-3.5 text-stone" aria-hidden />
      </button>
    );
  }

  return (
    <div className={cn("rounded-xl border border-gold/20 bg-gradient-to-b from-gold/[0.06] to-transparent p-3.5", className)}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="grid size-8 place-items-center rounded-lg bg-gold/10 text-gold">
            <Receipt className="size-4" aria-hidden />
          </span>
          <div>
            <p className="text-sm font-medium text-parchment">Siege fee paid via x402</p>
            {castleName ? <p className="text-xs text-stone">to lay siege on {castleName}</p> : null}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Amount amount={receipt.amount} asset={a} size="lg" animate={false} />
          {compact ? (
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-expanded
              aria-label="Collapse receipt"
              className="rounded p-1 text-stone hover:text-parchment"
            >
              <ChevronDown className="size-4 rotate-180" />
            </button>
          ) : null}
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-stone">Payer</dt>
        <dd className="min-w-0 justify-self-end">
          <HashscanLink accountId={receipt.payer} />
        </dd>
        <dt className="text-stone">Network</dt>
        <dd className="justify-self-end font-mono text-parchment/80">{receipt.network}</dd>
        <dt className="text-stone">Payment</dt>
        <dd className="min-w-0 justify-self-end">
          <HashscanLink tx={paidTx} />
        </dd>
      </dl>
    </div>
  );
}
