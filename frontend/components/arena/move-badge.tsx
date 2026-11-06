"use client";

import { Sprite } from "@/components/pixel/sprite";
import type { GuardianMove } from "@/lib/types";
import { MOVE_LABEL } from "@/lib/vocab";
import { cn } from "@/lib/utils";

const TONE: Record<GuardianMove, string> = {
  hold: "border-stamp-hold/60 text-stamp-hold",
  expose: "border-stamp-flag/60 text-stamp-flag",
  banish: "border-stamp-lockdown/70 text-stamp-lockdown",
  open: "border-stamp-breach/70 text-stamp-breach",
};

const ICON: Record<GuardianMove, string> = { hold: "move.hold", expose: "move.flag", banish: "move.lockdown", open: "move.breach" };

/**
 * The guard's move on a reply as a pixel chip: HOLD · FLAG (with what it spotted) · LOCKDOWN ·
 * BREACH, in the move colour with its icon.
 *
 * @example <MoveBadge move="expose" exposed="authority claim" />
 */
export function MoveBadge({ move, exposed, className }: { move: GuardianMove; exposed?: string; className?: string }) {
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5 border-2 bg-bg/60 px-1.5 py-0.5 font-ui text-[11px] leading-none tracking-[0.1em] uppercase", TONE[move], className)}>
      <Sprite name={ICON[move]} scale={1} />
      {MOVE_LABEL[move]}
      {move === "expose" && exposed ? <span className="truncate font-term text-[16px] tracking-normal text-ink normal-case">· {exposed}</span> : null}
    </span>
  );
}
