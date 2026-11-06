"use client";

import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/** Colour ramp for pressure 0–100: ward (calm) → gold (rising) → ember (danger). */
export function pressureColor(value: number): string {
  if (value >= 70) return "var(--color-ember)";
  if (value >= 40) return "var(--color-gold)";
  return "var(--color-ward)";
}

export function pressureWord(value: number): string {
  if (value >= 85) return "Breaking point";
  if (value >= 70) return "Heavy";
  if (value >= 40) return "Rising";
  if (value > 0) return "Calm";
  return "Quiet";
}

export type PressureMeterProps = {
  /** 0–100 referee pressure. */
  value: number;
  label?: string;
  /** e.g. "authority claim" — shown next to the label. */
  tactic?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
};

/**
 * How hard the raider is pushing (display only — never decides the outcome).
 *
 * @example <PressureMeter value={72} tactic="authority claim" />
 */
export function PressureMeter({ value, label = "Pressure", tactic, size = "md", className }: PressureMeterProps) {
  const reduced = useReducedMotion();
  const v = Math.max(0, Math.min(100, Math.round(Number.isFinite(value) ? value : 0)));
  const color = pressureColor(v);
  const h = size === "lg" ? "h-3" : size === "sm" ? "h-1.5" : "h-2";
  return (
    <div className={cn("w-full", className)}>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-xs">
        <span className="text-stone">
          {label}
          {tactic ? <span className="text-parchment/80"> · {tactic}</span> : null}
        </span>
        <span className="tabular font-medium" style={{ color }}>
          {v}
          <span className="text-stone">/100</span> <span className="hidden sm:inline">· {pressureWord(v)}</span>
        </span>
      </div>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={v}
        aria-label={label}
        className={cn("relative w-full overflow-hidden rounded-full bg-arena-line/70", h)}
      >
        <motion.div
          className="absolute inset-y-0 left-0 rounded-full"
          initial={false}
          animate={{ width: `${v}%`, backgroundColor: color }}
          transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 120, damping: 20 }}
          style={{ boxShadow: v >= 70 ? `0 0 12px ${color}` : undefined }}
        />
        {[40, 70].map((t) => (
          <span key={t} className="absolute inset-y-0 w-px bg-arena-bg/80" style={{ left: `${t}%` }} aria-hidden />
        ))}
      </div>
    </div>
  );
}
