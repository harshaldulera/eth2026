"use client";

import { useState } from "react";
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
  /** Render as a one-line chip that expands on click (op room header). */
  compact?: boolean;
  className?: string;
};

/** Stub receipts wear a dashed amber STUB tag in every form, so nobody mistakes one for a real payment. */
function StubTag() {
  return (
    <span className="shrink-0 border border-dashed border-money/70 px-1 font-ui text-[9px] leading-[14px] tracking-[0.12em] text-money uppercase" title="stub mode — no real HBAR moved">
      stub
    </span>
  );
}

/**
 * Proof that the op fee was paid via x402 on Hedera (or that it is a free recon). Drawn as a
 * printed ticket: a perforated edge, `PAID VIA x402`, the amount in arcade digits, payer and tx.
 *
 * @example <PaymentReceiptCard receipt={siege.receipt} castleName={castle.name} />
 * @example <PaymentReceiptCard receipt={siege.receipt} compact />
 */
export function PaymentReceiptCard({ receipt, castleName, asset, compact, className }: PaymentReceiptCardProps) {
  const [open, setOpen] = useState(false);

  if (receipt.free) {
    return (
      <div className={cn("flex items-center gap-2.5 border-2 border-dashed border-line bg-bg/40 px-3 py-2", className)}>
        <span className="shrink-0 font-ui text-[11px] tracking-[0.12em] text-accent uppercase">RECON</span>
        <div className="min-w-0 text-sm">
          <p className="text-ink">Free recon · no payout</p>
          <p className="truncate text-xs text-ink-dim">{compact ? "recon never pays out" : <>recon never pays out · wallet <span className="font-mono">{receipt.payer}</span></>}</p>
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
          "inline-flex max-w-full items-center gap-2 border-2 border-money/40 bg-money/[0.06] py-1 pr-2 pl-2 text-xs text-ink transition-colors hover:border-money/80",
          className,
        )}
      >
        <span className="font-ui text-[10px] tracking-[0.12em] text-money uppercase">receipt</span>
        <span>
          Paid <Amount amount={receipt.amount} asset={a} size="xs" animate={false} /> via x402
        </span>
        {receipt.stub ? <StubTag /> : null}
        <span aria-hidden className="font-ui text-[10px] text-ink-dim">▾</span>
      </button>
    );
  }

  return (
    <div className={cn("relative bg-panel px-frame [--frame:color-mix(in_oklab,var(--color-money)_45%,var(--color-line))]", className)}>
      {/* perforated top edge: a ticket torn off the x402 printer */}
      <div aria-hidden className="h-1.5 bg-[repeating-linear-gradient(90deg,var(--color-money)_0_6px,transparent_6px_10px)] opacity-40" />
      <div className="p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-2 font-ui text-[11px] tracking-[0.14em] text-money uppercase">
              Paid via x402 {receipt.stub ? <StubTag /> : null}
            </p>
            {castleName ? <p className="mt-1 truncate text-xs text-ink-dim">op fee · {castleName}</p> : null}
          </div>
          <div className="flex items-center gap-1">
            <Amount amount={receipt.amount} asset={a} size="lg" animate={false} />
            {compact ? (
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-expanded
                aria-label="Collapse receipt"
                className="px-1 font-ui text-xs text-ink-dim hover:text-ink"
              >
                ▴
              </button>
            ) : null}
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t-2 border-dashed border-line pt-2.5 text-xs">
          <dt className="font-ui text-[10px] tracking-[0.12em] text-ink-dim uppercase">Payer</dt>
          <dd className="min-w-0 justify-self-end">
            <HashscanLink accountId={receipt.payer} />
          </dd>
          <dt className="font-ui text-[10px] tracking-[0.12em] text-ink-dim uppercase">Network</dt>
          <dd className="justify-self-end font-mono text-ink">{receipt.network}</dd>
          <dt className="font-ui text-[10px] tracking-[0.12em] text-ink-dim uppercase">Payment</dt>
          <dd className="min-w-0 justify-self-end">
            <HashscanLink tx={paidTx} />
          </dd>
        </dl>
      </div>
    </div>
  );
}
