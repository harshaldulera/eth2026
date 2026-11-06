"use client";

import { Meter } from "@/components/pixel/meter";
import { PressureMeter } from "@/components/money/pressure-meter";
import { LED as LED_TEXT, threatWord } from "@/lib/vocab";
import { cn } from "@/lib/utils";

export type ThreatMeterProps = {
  value: number;
  /** Referee label of the latest message. */
  tactic?: string;
  /** Peak instead of current (ended ops). */
  peak?: boolean;
  /** Phone band: one line, no caption. */
  compact?: boolean;
  size?: "sm" | "md" | "lg";
  className?: string;
};

/**
 * The threat gauge in the op room: 10 cells, number and word, captioned "watchers only" because the
 * referee's score never decides anything.
 *
 * @example <ThreatMeter value={frame.threat} />
 */
export function ThreatMeter({ value, tactic, peak, compact, size = "md", className }: ThreatMeterProps) {
  if (compact) {
    const v = Math.max(0, Math.min(100, Math.round(value || 0)));
    return (
      <div className={cn("flex items-center gap-2", className)}>
        <span className="font-ui text-[10px] tracking-[0.1em] text-ink-dim">THREAT</span>
        <Meter value={v} size="sm" label="Threat (watchers only)" className="flex-1" />
        <span className="tabular font-ui text-[10px] text-ink">
          {String(v).padStart(2, "0")} {threatWord(v)}
        </span>
      </div>
    );
  }
  return <PressureMeter value={value} label={peak ? "Peak threat" : "Threat"} tactic={tactic} size={size} caption={LED_TEXT.watchersOnly} className={className} />;
}
