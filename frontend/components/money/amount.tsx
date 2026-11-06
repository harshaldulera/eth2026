"use client";

import { useEffect, useRef, useState } from "react";
import { animate, useReducedMotion } from "motion/react";
import type { Amount as AmountT, Asset } from "@/lib/types";
import { HBAR, formatAmount, formatDecimal, toNumber, toUnits } from "@/lib/money/format";
import { cn } from "@/lib/utils";

const SIZES = {
  xs: "text-xs",
  sm: "text-sm",
  md: "text-base",
  lg: "text-xl font-semibold",
  xl: "text-3xl font-semibold tracking-tight",
  hero: "text-5xl font-semibold tracking-tight sm:text-6xl",
} as const;

export type AmountProps = {
  /** Smallest units (tinybars for HBAR) as Amount string, bigint or number. */
  amount: AmountT | bigint | number;
  asset?: Asset;
  size?: keyof typeof SIZES;
  /** Count up/down from the previous value when `amount` changes (default true). */
  animate?: boolean;
  /** Prefix "+" for positive values. */
  sign?: boolean;
  /** Override the gold colour (e.g. "text-ward" for the castellan cut). */
  tone?: string;
  maxDecimals?: number;
  className?: string;
};

/**
 * Money, always gold and tabular. When the value changes it counts to the new value and glows
 * briefly so watchers see the pot move.
 *
 * @example <Amount amount={castle.pot} asset={castle.asset} size="hero" />
 * @example <Amount amount={split.castellan} tone="text-ward" sign />
 */
export function Amount({ amount, asset = HBAR, size = "md", animate: doAnimate = true, sign, tone, maxDecimals, className }: AmountProps) {
  const reduced = useReducedMotion();
  const units = toUnits(amount).toString();
  const prev = useRef(units);
  const [tween, setTween] = useState<{ value: number; dir: 1 | -1 } | null>(null);

  useEffect(() => {
    const from = prev.current;
    prev.current = units;
    if (from === units || !doAnimate || reduced) return;
    const a = toNumber(from, asset);
    const b = toNumber(units, asset);
    const dir = b >= a ? 1 : -1;
    const controls = animate(a, b, {
      duration: Math.min(1.4, 0.5 + Math.abs(b - a) / Math.max(Math.abs(b), 1)),
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setTween({ value: v, dir }),
      onComplete: () => setTween(null),
    });
    return () => controls.stop();
  }, [units, doAnimate, reduced, asset]);

  const text = tween
    ? formatDecimal(tween.value, asset, { maxDecimals })
    : formatAmount(units, asset, { maxDecimals, sign });

  return (
    <span
      className={cn(
        "tabular inline-block whitespace-nowrap transition-[text-shadow] duration-500",
        tone ?? "text-gold",
        SIZES[size],
        tween && tween.dir > 0 && "[text-shadow:0_0_18px_rgb(245_196_81/0.65)]",
        className,
      )}
      aria-label={formatAmount(units, asset, { maxDecimals: asset.decimals, sign })}
    >
      {text}
    </span>
  );
}
