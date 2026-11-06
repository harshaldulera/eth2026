"use client";

import type { ReactNode } from "react";
import { VaultPayout } from "@/components/money/vault-payout";
import type { SceneFrame } from "@/lib/scene/player";
import type { Amount, Asset, SiegeStatus } from "@/lib/types";
import { MONEY, STAMPS } from "@/lib/vocab";
import { cn } from "@/lib/utils";
import { SplitBars } from "./split-bars";

export type OutcomeHeadlineProps = {
  status?: SiegeStatus;
  /** Messages a lockdown cut off. */
  lost?: number;
  streak?: number;
  free?: boolean;
  wall?: boolean;
  children?: ReactNode;
  className?: string;
};

/**
 * `OP COMPLETE · GUARD HELD · STREAK 213` / `LOCKDOWN · 2 MESSAGES LOST · STREAK 213` /
 * `BREACH` / `RECON · NO PAYOUT`, in the outcome colour.
 */
export function OutcomeHeadline({ status, lost = 0, streak, free, wall, children, className }: OutcomeHeadlineProps) {
  const streakText = streak !== undefined && status !== "broken" ? ` · STREAK ${streak}` : "";
  const text =
    status === "held"
      ? `${STAMPS.opComplete}${streakText}`
      : status === "banished"
        ? `${STAMPS.lockdownLost(lost)}${streakText}`
        : status === "broken"
          ? free
            ? "RECON BREACH · NO PAYOUT"
            : "BREACH · THE VAULT PAID OUT"
          : "OP OVER";
  const tone = status === "held" ? "text-safe" : status === "banished" ? "text-threat" : "text-money";
  return (
    <div className={cn("bg-raised px-3 py-2.5 px-frame", className)} role="status">
      <p className={cn("font-pixel leading-snug", tone, wall ? "text-3xl" : "text-[14px]")}>{text}</p>
      {children ? <div className={cn("mt-1.5 text-ink-dim", wall ? "text-2xl" : "text-sm")}>{children}</div> : null}
    </div>
  );
}

export type SceneOutcomeProps = {
  frame: SceneFrame;
  fee: Amount;
  asset?: Asset;
  streak?: number;
  wall?: boolean;
  className?: string;
};

/**
 * The end sequence straight from a frame (replay and wall): headline, then the fee rail (held /
 * lockdown) or the payout (breach). The live op room renders its own, richer branches.
 */
export function SceneOutcome({ frame: f, fee, asset, streak, wall, className }: SceneOutcomeProps) {
  if (!f.status) return null;
  const c = f.coins;
  return (
    <div className={cn("space-y-3", className)}>
      <OutcomeHeadline status={f.status} lost={f.pipsLost} streak={streak} free={f.free} wall={wall}>
        {f.free ? MONEY.reconNoPayout : null}
      </OutcomeHeadline>
      {c.kind === "split" ? <SplitBars fee={fee} split={c.split} newPot={c.newPot} tx={c.tx} asset={asset} progress={c.pending ? 0 : c.progress} size={wall ? "wall" : "md"} /> : null}
      {c.kind === "payout" && c.amount ? (
        // The wall is read from across a room: the payout card is drawn at 1.2× there (CSS zoom keeps layout
        // honest); any larger and it pushes the guard's reply out of the console.
        <div className={cn(wall && "[zoom:1.2]")}>
          <VaultPayout amount={c.amount} raider={c.raider ?? ""} tx={c.tx} pending={c.pending} asset={asset} />
        </div>
      ) : null}
    </div>
  );
}
