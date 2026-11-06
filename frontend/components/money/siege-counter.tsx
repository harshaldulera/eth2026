"use client";

import { motion } from "motion/react";
import type { SiegeStatus } from "@/lib/types";
import { MAX_TURNS } from "@/lib/types";
import { cn } from "@/lib/utils";

export type SiegeCounterProps = {
  /** Turns used (0–5). */
  used: number;
  total?: number;
  status?: SiegeStatus;
  showLabel?: boolean;
  className?: string;
};

/**
 * Five pips: one per message the raider paid for. Used pips burn ember; when the siege ends the
 * pips take the outcome colour (ward = held, gold = broken, ember = banished).
 *
 * @example <SiegeCounter used={siege.turn} status={siege.status} />
 */
export function SiegeCounter({ used, total = MAX_TURNS, status, showLabel = true, className }: SiegeCounterProps) {
  const ended = status === "held" || status === "broken" || status === "banished";
  const fill = status === "held" ? "bg-ward" : status === "broken" ? "bg-gold" : "bg-ember";
  const left = Math.max(0, total - used);
  return (
    <div className={cn("flex items-center gap-2.5", className)} aria-label={`${used} of ${total} messages used`}>
      <div className="flex gap-1.5">
        {Array.from({ length: total }, (_, i) => {
          const on = i < used;
          return (
            <motion.span
              key={i}
              initial={false}
              animate={{ scale: on ? 1 : 0.85 }}
              className={cn(
                "block h-2.5 w-5 rounded-full border transition-colors duration-300",
                on ? cn(fill, "border-transparent") : "border-arena-line bg-transparent",
                on && !ended && i === used - 1 && "shadow-[0_0_10px_var(--color-ember)]",
              )}
            />
          );
        })}
      </div>
      {showLabel ? (
        <span className="tabular text-xs text-stone">
          {ended ? `${used}/${total} used` : left === 1 ? "1 message left" : `${left} messages left`}
        </span>
      ) : null}
    </div>
  );
}
