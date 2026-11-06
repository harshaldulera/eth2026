"use client";

import type { ReactNode } from "react";
import { motion } from "motion/react";
import type { Amount as AmountT, Asset, TxRef } from "@/lib/types";
import { HBAR } from "@/lib/money/format";
import { useCalmMotion } from "@/lib/hooks/usePrefs";
import { cn } from "@/lib/utils";
import { Digits } from "@/components/pixel/digits";
import { Sprite } from "@/components/pixel/sprite";
import { CoinFountain, money } from "@/components/scene/coin-fountain";
import { HashscanLink } from "./hashscan-link";
import Link from "next/link";
import { UNITS } from "@/lib/vocab";

export type VaultPayoutProps = {
  /** Amount paid to the operator (pot + this op's fee). */
  amount: AmountT;
  /** Operator account the vault paid. */
  raider: string;
  /** The release tx; omit while it is settling. */
  tx?: TxRef;
  /** The release has not landed yet: `PAYING OUT…` instead of `PAID … TO …`. */
  pending?: boolean;
  /**
   * The paid account is this browser's own (a unit or operator account): `PAID 5.50 ℏ TO GLASS FOX ·
   * YOUR ACCOUNT (0.0.…)` and a WITHDRAW link to the agents page.
   */
  toName?: string;
  asset?: Asset;
  /** Extra lines under the receipt (e.g. `BREACH LANDED IN THE HALL`). */
  children?: ReactNode;
  className?: string;
};

/**
 * The breach payout: the vault door open, a coin burst and the hero amount. Reads `PAYING OUT…`
 * until the release lands, then `PAID 5.50 ℏ TO 0.0.1132… ↗`. Reduced motion: no burst, the amount
 * fades in.
 *
 * @example <VaultPayout amount={siege.release.amount} raider={siege.raider} tx={siege.release} />
 */
export function VaultPayout({ amount, raider, tx, pending = false, toName, asset = HBAR, children, className }: VaultPayoutProps) {
  const calm = useCalmMotion();
  const shown = money(amount, asset);
  const [num, unit] = [shown.slice(0, shown.lastIndexOf(" ")), shown.slice(shown.lastIndexOf(" ") + 1)];
  return (
    <div
      className={cn(
        "relative overflow-hidden bg-panel px-4 pt-3 pb-3 text-center px-frame [--frame:color-mix(in_oklab,var(--color-money)_60%,var(--color-line))]",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      {/* light pouring out of the vault */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_60%_70%_at_50%_30%,color-mix(in_oklab,var(--color-money)_22%,transparent),transparent_70%)]"
      />
      <div className="relative mx-auto mb-2 w-fit">
        <Sprite name="door.open" scale={3} animate={{ loop: false }} label="Vault open" />
        <CoinFountain count={20} scale={3} className="top-[45%]" />
      </div>
      <p className="relative font-ui text-[11px] tracking-[0.18em] text-money/80 uppercase">The vault is open</p>
      <motion.div
        initial={calm ? { opacity: 0 } : { scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={calm ? { duration: 0.3 } : { type: "spring", stiffness: 420, damping: 18 }}
        className="relative mt-2"
      >
        <Digits value={num} unit={unit} size="xl" tone="money" />
      </motion.div>
      <div className="relative mt-3 flex flex-col items-center gap-1.5">
        {pending ? (
          <p className="font-ui text-xs tracking-[0.12em] text-money uppercase">
            <span className="animate-blink">▮</span> Paying out to {toName ? <>{UNITS.payoutToYou(toName)} (</> : null}
            <HashscanLink accountId={raider} className="text-xs" />
            {toName ? ")" : null}
          </p>
        ) : (
          <p className="font-ui text-xs tracking-[0.12em] text-money uppercase" data-testid="payout-to">
            Paid {shown} to {toName ? <>{UNITS.payoutToYou(toName)} (</> : null}
            <HashscanLink accountId={raider} className="text-xs" />
            {toName ? ")" : null}
          </p>
        )}
        {tx ? (
          <p className="flex items-center gap-2 font-term text-lg leading-none text-ink-dim">
            release tx <HashscanLink tx={tx} />
          </p>
        ) : (
          <p className="font-term text-lg leading-none text-ink-dim">verifier signed · settling on Hedera…</p>
        )}
        {toName ? (
          <Link href="/raider" className="font-ui text-[11px] tracking-[0.12em] text-accent uppercase underline-offset-4 hover:underline">
            {UNITS.payoutWithdraw}
          </Link>
        ) : null}
        {children}
      </div>
    </div>
  );
}
