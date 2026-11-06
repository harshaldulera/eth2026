import * as React from "react";
import { cn } from "@/lib/utils";

const SIZE = {
  sm: "text-[14px]",
  md: "text-lg",
  lg: "text-2xl",
  xl: "text-4xl",
  "2xl": "text-5xl sm:text-6xl",
} as const;

const TONE = {
  ink: "text-ink",
  money: "text-money",
  accent: "text-accent",
  threat: "text-threat",
  safe: "text-safe",
  warn: "text-warn",
  dim: "text-ink-dim",
} as const;

export type DigitsProps = {
  value: React.ReactNode;
  /** Zero-pad numbers to this many digits (`OPS 0412`). */
  pad?: number;
  size?: keyof typeof SIZE;
  tone?: keyof typeof TONE;
  /** Phosphor glow (default on). */
  glow?: boolean;
  /** Small caption after the number (`ℏ`). Rendered smaller, same tone. */
  unit?: React.ReactNode;
  className?: string;
};

/**
 * Big arcade number in Press Start 2P, tabular, glowing. Never below 14 px.
 *
 * @example <Digits value={412} pad={4} />  <Digits value="25.00" unit="ℏ" tone="money" size="xl" />
 */
export function Digits({ value, pad, size = "md", tone = "ink", glow = true, unit, className }: DigitsProps) {
  const text = typeof value === "number" && pad ? String(Math.max(0, Math.trunc(value))).padStart(pad, "0") : value;
  return (
    <span
      className={cn(
        "tabular inline-flex items-baseline gap-1.5 font-pixel leading-none",
        SIZE[size],
        TONE[tone],
        glow && "[text-shadow:0_0_8px_color-mix(in_oklab,currentColor_55%,transparent)]",
        className,
      )}
    >
      {text}
      {unit ? <span className="text-[0.6em]">{unit}</span> : null}
    </span>
  );
}
