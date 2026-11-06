"use client";

import { useEffect, useRef, useState } from "react";
import { animate } from "motion/react";
import type { Amount as AmountT, Asset } from "@/lib/types";
import { HBAR, formatAmount, formatDecimal, toNumber, toUnits } from "@/lib/money/format";
import { useCalmMotion } from "@/lib/hooks/usePrefs";
import { Digits, type DigitsProps } from "@/components/pixel/digits";
import { cn } from "@/lib/utils";

/** Inline sizes (sentences, table cells) stay in the readable mono face. */
const INLINE = {
  xs: "text-xs",
  sm: "text-sm",
  md: "text-base",
} as const;

/** Display sizes are arcade digits (Press Start 2P, never below 14 px). */
const DISPLAY: Record<"lg" | "xl" | "hero", NonNullable<DigitsProps["size"]>> = {
  lg: "md",
  xl: "lg",
  hero: "2xl",
};

type Size = keyof typeof INLINE | keyof typeof DISPLAY;

export type AmountProps = {
  /** Smallest units (tinybars for HBAR) as Amount string, bigint or number. */
  amount: AmountT | bigint | number;
  asset?: Asset;
  size?: Size;
  /** Count up/down from the previous value when `amount` changes (default true). */
  animate?: boolean;
  /** Prefix "+" for positive values. */
  sign?: boolean;
  /** Override the money colour (e.g. "text-ward" for the owner's cut). */
  tone?: string;
  maxDecimals?: number;
  className?: string;
};

/** "1,234.5 ℏ" → ["1,234.5", "ℏ"]; anything without a symbol stays whole. */
function splitUnit(text: string): [string, string | null] {
  const i = text.lastIndexOf(" ");
  return i > 0 ? [text.slice(0, i), text.slice(i + 1)] : [text, null];
}

/**
 * Money: always amber, always tabular. `lg` and up render as arcade digits with the unit set
 * smaller. When the value changes it counts to the new value and glows while rising, so watchers
 * see the pot move. Reduced motion (OS or `?calm=1`) jumps straight to the new value.
 *
 * @example <Amount amount={castle.pot} asset={castle.asset} size="hero" />
 * @example <Amount amount={split.castellan} tone="text-ward" sign />
 */
export function Amount({ amount, asset = HBAR, size = "md", animate: doAnimate = true, sign, tone, maxDecimals, className }: AmountProps) {
  const calm = useCalmMotion();
  const units = toUnits(amount).toString();
  const prev = useRef(units);
  const [tween, setTween] = useState<{ value: number; dir: 1 | -1 } | null>(null);

  useEffect(() => {
    const from = prev.current;
    prev.current = units;
    if (from === units || !doAnimate || calm) return;
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
  }, [units, doAnimate, calm, asset]);

  const label = formatAmount(units, asset, { maxDecimals: asset.decimals, sign });
  const text = tween
    ? `${sign && tween.value > 0 ? "+" : ""}${formatDecimal(tween.value, asset, { maxDecimals })}`
    : formatAmount(units, asset, { maxDecimals, sign });
  const rising = Boolean(tween && tween.dir > 0);

  if (size === "lg" || size === "xl" || size === "hero") {
    const [num, unit] = splitUnit(text);
    return (
      <span className={cn("inline-block whitespace-nowrap", className)}>
        <span className="sr-only">{label}</span>
        <span aria-hidden>
          <Digits value={num} unit={unit} size={DISPLAY[size]} tone="money" className={cn(tone, rising && "glow-strong")} />
        </span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        "tabular inline-block whitespace-nowrap transition-[text-shadow] duration-500",
        tone ?? "text-money",
        INLINE[size],
        rising && "[text-shadow:0_0_14px_color-mix(in_oklab,currentColor_70%,transparent)]",
        className,
      )}
      aria-label={label}
    >
      {text}
    </span>
  );
}
