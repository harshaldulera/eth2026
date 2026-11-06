"use client";

import type { CSSProperties } from "react";
import { Sprite } from "@/components/pixel/sprite";
import { guardKind, guardSprite, type GuardScenePose } from "@/lib/pixel/manifest";
import { cn } from "@/lib/utils";

export type GuardIdentity = { personality?: string | null; transport?: string | null; guardianName?: string | null };

export type GuardSpriteProps = {
  guard: GuardIdentity;
  pose?: GuardScenePose;
  /** Integer pixel scale (16 px art → 16 × scale). */
  scale?: number;
  /** Role-override flicker: draw the guard as a hollow outline. */
  hollow?: boolean;
  /** Still frame instead of the pose animation (lists, thumbnails). */
  still?: boolean;
  label?: string;
  className?: string;
  style?: CSSProperties;
};

/** Hollow outline: black fill + 1-art-pixel accent rim (four hard drop shadows). */
const HOLLOW: CSSProperties = {
  filter:
    "brightness(0) drop-shadow(2px 0 0 var(--color-accent)) drop-shadow(-2px 0 0 var(--color-accent)) drop-shadow(0 2px 0 var(--color-accent)) drop-shadow(0 -2px 0 var(--color-accent))",
  opacity: 0.85,
};

/**
 * A vault's guard in a scene pose (idle bob, think, hold, flag, lockdown, breach). Picks the
 * portrait from the castle (SDK vaults get Penny behind glass; hosted ones their personality).
 *
 * @example <GuardSprite guard={castle} pose={frame.guard} scale={5} />
 */
export function GuardSprite({ guard, pose = "idle", scale, hollow, still, label, className, style }: GuardSpriteProps) {
  const g = guardSprite(guardKind(guard), pose);
  return (
    <Sprite
      name={g.name}
      scale={scale}
      animate={still ? false : g.animate}
      label={label}
      className={cn("pixelated", className)}
      style={{ ...(hollow ? HOLLOW : null), ...style }}
    />
  );
}

/** Art width of a guard's portrait in sprite pixels (the Iron Warden is 24 wide). */
export function guardArtWidth(guard: GuardIdentity): number {
  return guardKind(guard) === "paranoid" ? 24 : 16;
}

/** Voice tag per personality preset (design §3.2). */
export function voiceTag(guard: GuardIdentity): string {
  const k = guardKind(guard);
  return (
    { bumbling: "CHEERFUL", stern: "TERSE", bureaucratic: "FORMAL", mocking: "DRY", paranoid: "PARANOID", "support-bot": "HELPFUL" } as Record<string, string>
  )[k] ?? "TERSE";
}
