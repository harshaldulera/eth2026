"use client";

import { Meter } from "@/components/pixel/meter";
import { threatWord } from "@/lib/vocab";
import { cn } from "@/lib/utils";

/** Colour ramp for threat 0–100: safe (calm) → warn (rising) → threat (danger). */
export function pressureColor(value: number): string {
  if (value >= 70) return "var(--color-threat)";
  if (value >= 40) return "var(--color-warn)";
  return "var(--color-safe)";
}

/** Threat as a word: QUIET · LOW · RISING · HIGH · CRITICAL (copy deck). */
export function pressureWord(value: number): string {
  return threatWord(value);
}

const TEXT_TONE = (v: number) => (v >= 70 ? "text-threat" : v >= 40 ? "text-warn" : v > 0 ? "text-safe" : "text-ink-dim");

export type PressureMeterProps = {
  /** 0–100 referee pressure. */
  value: number;
  label?: string;
  /** e.g. "authority claim" — shown next to the label. */
  tactic?: string;
  size?: "sm" | "md" | "lg";
  /** Caption under the bar (the op room says "watchers only"). */
  caption?: string;
  className?: string;
};

/**
 * Threat gauge (display only — it never decides the outcome): 10 segments that light in the
 * threat colour ramp, the number and the word.
 *
 * @example <PressureMeter value={72} tactic="authority claim" />
 */
export function PressureMeter({ value, label = "Threat", tactic, size = "md", caption, className }: PressureMeterProps) {
  const v = Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
  return (
    <div className={cn("w-full min-w-0", className)}>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate font-ui text-[11px] tracking-[0.1em] text-ink-dim uppercase">
          {label}
          {tactic ? <span className="text-ink normal-case"> · {tactic}</span> : null}
        </span>
        <span className={cn("tabular shrink-0 font-ui text-[11px] tracking-[0.08em]", TEXT_TONE(v))}>
          {String(v).padStart(2, "0")} · {pressureWord(v)}
        </span>
      </div>
      <Meter value={v} max={100} cells={10} size={size} label={label} />
      {caption ? <p className="mt-1 font-ui text-[10px] tracking-[0.1em] text-ink-dim uppercase">{caption}</p> : null}
    </div>
  );
}
