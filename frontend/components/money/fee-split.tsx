"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Castle, Coins, Landmark, Shield } from "lucide-react";
import type { Amount as AmountT, Asset, FeeSplit as FeeSplitT, TxRef } from "@/lib/types";
import { HBAR, toUnits } from "@/lib/money/format";
import { cn } from "@/lib/utils";
import { Amount } from "./amount";
import { HashscanLink } from "./hashscan-link";

export type FeeSplitProps = {
  /** The siege fee that was split. */
  fee: AmountT;
  /** On-chain split from AttemptRecorded; omit while settling. */
  split?: FeeSplitT;
  /** Pot after this siege; the pot row ticks up to it. */
  newPot?: AmountT;
  castellanLabel?: string;
  /** The recordAttempt tx. */
  tx?: TxRef;
  asset?: Asset;
  title?: string;
  className?: string;
};

function pct(part: AmountT, whole: AmountT): number {
  const w = toUnits(whole);
  if (w <= BigInt(0)) return 0;
  return Number((toUnits(part) * BigInt(10000)) / w) / 100;
}

/**
 * Where the raider's fee went when the guardian held: castellan / pot / arena, straight from the
 * contract's AttemptRecorded event.
 *
 * @example <FeeSplit fee={castle.fee} split={split} newPot={newPot} tx={siege.attempt} />
 */
export function FeeSplit({ fee, split, newPot, castellanLabel = "Castellan", tx, asset = HBAR, title = "Fee split on Hedera", className }: FeeSplitProps) {
  const reduced = useReducedMotion();
  const rows = split
    ? [
        { key: "castellan", label: castellanLabel, hint: "paid to the defender", amount: split.castellan, color: "var(--color-ward)", tone: "text-ward", Icon: Shield },
        { key: "pot", label: "Pot", hint: "grows the vault", amount: split.pot, color: "var(--color-gold)", tone: "text-gold", Icon: Coins },
        { key: "arena", label: "Arena", hint: "keeps the lights on", amount: split.arena, color: "var(--color-stone)", tone: "text-stone", Icon: Landmark },
      ]
    : [];

  return (
    <div className={cn("rounded-2xl border border-arena-line bg-arena-panel p-4", className)}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-xs font-semibold tracking-[0.14em] text-stone uppercase">{title}</p>
        <span className="text-xs text-stone">
          fee <Amount amount={fee} asset={asset} size="xs" animate={false} />
        </span>
      </div>

      {!split ? (
        <div aria-live="polite" className="space-y-2">
          <p className="flex items-center gap-2 text-sm text-parchment/80">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-gold opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-gold" />
            </span>
            Settling on Hedera…
          </p>
          {[0, 1, 2].map((i) => (
            <div key={i} className="shimmer h-9 rounded-lg" />
          ))}
        </div>
      ) : (
        <ul className="space-y-2" aria-live="polite">
          <AnimatePresence initial>
            {rows.map((r, i) => (
              <motion.li
                key={r.key}
                initial={reduced ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: reduced ? 0 : 0.15 + i * 0.28, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
                className="relative overflow-hidden rounded-lg border border-arena-line bg-arena-bg/40 px-3 py-2"
              >
                <motion.span
                  aria-hidden
                  className="absolute inset-y-0 left-0 opacity-[0.12]"
                  style={{ backgroundColor: r.color }}
                  initial={reduced ? false : { width: 0 }}
                  animate={{ width: `${pct(r.amount, fee)}%` }}
                  transition={{ delay: reduced ? 0 : 0.3 + i * 0.28, duration: 0.6, ease: "easeOut" }}
                />
                <div className="relative flex items-center justify-between gap-3">
                  <span className="flex items-center gap-2 text-sm">
                    <r.Icon className={cn("size-4", r.tone)} aria-hidden />
                    <span className={r.tone}>{r.label}</span>
                    <span className="hidden text-xs text-stone sm:inline">{r.hint}</span>
                  </span>
                  <span className="flex items-baseline gap-2">
                    <span className="tabular text-[11px] text-stone">{pct(r.amount, fee).toFixed(0)}%</span>
                    <Amount amount={r.amount} asset={asset} sign tone={r.key === "pot" ? "text-gold" : r.tone} animate={false} />
                  </span>
                </div>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {split && newPot ? (
        <PotTicker newPot={newPot} potCut={split.pot} asset={asset} delayMs={reduced ? 0 : 1100} />
      ) : null}

      {tx ? (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-arena-line pt-3 text-xs">
          <span className="text-stone">AttemptRecorded</span>
          <HashscanLink tx={tx} />
        </div>
      ) : null}
    </div>
  );
}

/** Pot row: starts at the old pot and ticks to the new one once the split has landed. */
function PotTicker({ newPot, potCut, asset, delayMs }: { newPot: AmountT; potCut: AmountT; asset: Asset; delayMs: number }) {
  const before = (toUnits(newPot) - toUnits(potCut)).toString();
  const [shown, setShown] = useState(delayMs > 0 ? before : newPot);
  useEffect(() => {
    const t = setTimeout(() => setShown(newPot), delayMs);
    return () => clearTimeout(t);
  }, [newPot, delayMs]);
  return (
    <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-gold/[0.06] px-3 py-2.5">
      <span className="flex items-center gap-2 text-sm text-parchment">
        <Castle className="size-4 text-gold" aria-hidden />
        Pot now
      </span>
      <Amount amount={shown} asset={asset} size="lg" />
    </div>
  );
}
