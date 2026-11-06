"use client";

import type { SiegeStatus } from "@/lib/types";
import { MAX_TURNS } from "@/lib/types";
import { Pips } from "@/components/pixel/pips";

export type SiegeCounterProps = {
  /** Turns used (0–5). */
  used: number;
  total?: number;
  status?: SiegeStatus;
  showLabel?: boolean;
  className?: string;
};

/**
 * Five message pips `■■□□□` (now the pixel `Pips`; props unchanged). Used pips burn in the outcome
 * colour once the op ends; a lockdown crosses out the rest with `N LOST`.
 *
 * @example <SiegeCounter used={siege.turn} status={siege.status} />
 */
export function SiegeCounter({ used, total = MAX_TURNS, status, showLabel = true, className }: SiegeCounterProps) {
  return <Pips used={used} total={total} status={status} showLabel={showLabel} className={className} />;
}
