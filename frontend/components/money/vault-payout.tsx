"use client";

import { motion, useReducedMotion } from "motion/react";
import { DoorOpen } from "lucide-react";
import type { Amount as AmountT, Asset, TxRef } from "@/lib/types";
import { HBAR } from "@/lib/money/format";
import { cn } from "@/lib/utils";
import { Amount } from "./amount";
import { HashscanLink } from "./hashscan-link";

const COINS = 24;
// Deterministic burst (golden-angle spread), so render stays pure and every replay looks the same.
const BURST = Array.from({ length: COINS }, (_, i) => {
  const angle = i * 2.399963 + 0.3;
  const dist = 90 + ((i * 37) % 70);
  return {
    x: Math.cos(angle) * dist,
    y: Math.sin(angle) * dist * 0.75 - 30,
    fall: 40 + ((i * 53) % 60),
    rot: ((i * 97) % 360) - 180,
    delay: 0.05 + (i % 6) * 0.03,
    size: 8 + (i % 3) * 3,
  };
});

export type VaultPayoutProps = {
  /** Amount paid to the raider (pot + this siege's fee). */
  amount: AmountT;
  /** Raider account the vault paid. */
  raider: string;
  /** The release tx; omit while it is settling. */
  tx?: TxRef;
  /** The release has not landed yet: say "Paying out…" instead of "Paid to". */
  pending?: boolean;
  asset?: Asset;
  className?: string;
};

/**
 * The doors-open moment: the vault paid out. Gold amount scales in under a burst of coins
 * (none with prefers-reduced-motion).
 *
 * @example <VaultPayout amount={siege.release.amount} raider={siege.raider} tx={siege.release} />
 */
export function VaultPayout({ amount, raider, tx, pending = false, asset = HBAR, className }: VaultPayoutProps) {
  const reduced = useReducedMotion();
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-gold/40 bg-[radial-gradient(ellipse_at_50%_35%,rgb(245_196_81/0.22),transparent_65%)] px-5 pt-8 pb-5 text-center",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      {!reduced ? (
        <div aria-hidden className="pointer-events-none absolute top-[38%] left-1/2">
          {BURST.map((c, i) => (
            <motion.span
              key={i}
              className="absolute block rounded-full border border-[#ffe08a] bg-gold shadow-[0_0_8px_rgb(245_196_81/0.7)]"
              style={{ width: c.size, height: c.size, marginLeft: -c.size / 2, marginTop: -c.size / 2 }}
              initial={{ x: 0, y: 0, opacity: 0, scale: 0.3, rotate: 0 }}
              animate={{
                x: [0, c.x, c.x * 1.1],
                y: [0, c.y, c.y + c.fall],
                opacity: [0, 1, 0],
                scale: [0.3, 1, 0.8],
                rotate: c.rot,
              }}
              transition={{ duration: 1.5, delay: c.delay, ease: [0.2, 0.8, 0.4, 1], times: [0, 0.45, 1] }}
            />
          ))}
        </div>
      ) : null}

      <motion.div
        initial={reduced ? false : { scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 18 }}
        className="relative"
      >
        <span className="mx-auto mb-3 grid size-12 place-items-center rounded-2xl bg-gold/15 text-gold">
          <DoorOpen className="size-6" aria-hidden />
        </span>
        <p className="text-xs font-semibold tracking-[0.18em] text-gold/80 uppercase">The vault is open</p>
        <div className="mt-2">
          <Amount amount={amount} asset={asset} size="hero" animate={false} />
        </div>
      </motion.div>

      <motion.div
        initial={reduced ? false : { opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: reduced ? 0 : 0.5 }}
        className="relative mt-4 flex flex-col items-center gap-1.5 text-sm"
      >
        <p className="text-parchment/90">
          {pending ? "Paying out to" : "Paid to"} <HashscanLink accountId={raider} className="text-sm" />
        </p>
        {tx ? (
          <p className="flex items-center gap-2 text-xs text-stone">
            release tx <HashscanLink tx={tx} />
          </p>
        ) : (
          <p className="text-xs text-stone">Verifier signed · settling on Hedera…</p>
        )}
      </motion.div>
    </div>
  );
}
