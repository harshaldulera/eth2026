import * as React from "react";
import { cn } from "@/lib/utils";

export type MeterTone = "auto" | "threat" | "money" | "safe" | "warn" | "accent" | "ink";

const FILL: Record<Exclude<MeterTone, "auto">, string> = {
  threat: "bg-threat",
  money: "bg-money",
  safe: "bg-safe",
  warn: "bg-warn",
  accent: "bg-accent",
  ink: "bg-ink",
};

/** Threat-style tone by fill: < 40 % safe, < 70 % warn, else threat. */
export function autoTone(fraction: number): Exclude<MeterTone, "auto"> {
  if (fraction >= 0.7) return "threat";
  if (fraction >= 0.4) return "warn";
  return "safe";
}

export type MeterProps = {
  value: number;
  max?: number;
  /** Number of segments (default 10). */
  cells?: number;
  tone?: MeterTone;
  /** Values (in the same units as `value`) to mark with a tick under the bar, e.g. a cap. */
  ticks?: number[];
  /** Cell height. */
  size?: "sm" | "md" | "lg";
  /** Accessible name; also shown before the bar when `showLabel`. */
  label?: string;
  showLabel?: boolean;
  /** Text after the bar (e.g. `42`, `1.5 / 4 ℏ`). */
  valueText?: React.ReactNode;
  className?: string;
};

const H = { sm: "h-2", md: "h-3", lg: "h-5" } as const;

/**
 * Segmented meter: whole cells light up, so it reads like a game gauge. Base of the threat meter
 * and the agent budget gauges.
 *
 * @example <Meter value={42} label="Threat" valueText="42" />  <Meter value={1.5} max={4} tone="money" ticks={[3]} />
 */
export function Meter({ value, max = 100, cells = 10, tone = "auto", ticks, size = "md", label, showLabel, valueText, className }: MeterProps) {
  const safeMax = max > 0 ? max : 1;
  const v = Number.isFinite(value) ? Math.min(Math.max(value, 0), safeMax) : 0;
  const frac = v / safeMax;
  const lit = v > 0 ? Math.max(1, Math.round(frac * cells)) : 0;
  const fill = FILL[tone === "auto" ? autoTone(frac) : tone];
  return (
    <div className={cn("flex items-center gap-2", className)}>
      {showLabel && label ? <span className="font-ui text-[11px] tracking-[0.1em] text-ink-dim uppercase">{label}</span> : null}
      <div className="relative min-w-0 flex-1">
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={safeMax}
          aria-valuenow={v}
          className="flex gap-[2px] bg-bg/70 p-[2px] shadow-[inset_0_0_0_1px_var(--color-line)]"
        >
          {Array.from({ length: cells }, (_, i) => (
            <span
              key={i}
              className={cn(
                "min-w-[3px] flex-1 transition-colors duration-300",
                H[size],
                i < lit ? cn(fill, "shadow-[0_0_4px_-1px_currentColor]") : "bg-line/45",
              )}
            />
          ))}
        </div>
        {ticks?.length ? (
          <div className="pointer-events-none absolute inset-x-[2px] -bottom-1.5 h-1.5" aria-hidden>
            {ticks
              .filter((t) => t > 0 && t <= safeMax)
              .map((t) => (
                <span key={t} className="absolute top-0 h-1.5 w-[2px] bg-ink-dim" style={{ left: `calc(${(t / safeMax) * 100}% - 1px)` }} />
              ))}
          </div>
        ) : null}
      </div>
      {valueText != null ? <span className="tabular shrink-0 font-ui text-xs text-ink">{valueText}</span> : null}
    </div>
  );
}
