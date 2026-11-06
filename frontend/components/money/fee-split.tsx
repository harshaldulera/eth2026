"use client";

import type { Amount as AmountT, Asset, FeeSplit as FeeSplitT, TxRef } from "@/lib/types";
import { HBAR } from "@/lib/money/format";
import { SplitBars } from "@/components/scene/split-bars";

export type FeeSplitProps = {
  /** The op fee that was split. */
  fee: AmountT;
  /** On-chain split from AttemptRecorded; omit while settling. */
  split?: FeeSplitT;
  /** Pot after this op; the pot ticker counts up to it. */
  newPot?: AmountT;
  /** Lane label for the defender's share (default `Owner`). */
  castellanLabel?: string;
  /** The recordAttempt tx. */
  tx?: TxRef;
  asset?: Asset;
  title?: string;
  /** 0–1 sort progress driven by a scene (optional; plays once on mount otherwise). */
  progress?: number;
  className?: string;
};

/**
 * Where the operator's fee went when the guard held: OWNER / POT / ARENA, straight from the
 * contract's AttemptRecorded event, drawn as the pixel fee rail (`SplitBars`). Props unchanged.
 *
 * @example <FeeSplit fee={castle.fee} split={split} newPot={newPot} tx={siege.attempt} />
 */
export function FeeSplit({ fee, split, newPot, castellanLabel = "Owner", tx, asset = HBAR, title = "Fee rail", progress, className }: FeeSplitProps) {
  return <SplitBars fee={fee} split={split} newPot={newPot} tx={tx} asset={asset} title={title} ownerLabel={castellanLabel} progress={progress} className={className} />;
}
