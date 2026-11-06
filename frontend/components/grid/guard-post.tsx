"use client";

import type { Castle, VaultState } from "@/lib/types";
import { guardKind, guardSprite } from "@/lib/pixel/manifest";
import { vaultStateOf } from "@/lib/money/vault";
import { Sprite } from "@/components/pixel/sprite";
import { cn } from "@/lib/utils";

type DoorState = "closed" | "shaking" | "open";

/** What the post shows for a vault state: who stands where, and how the door looks. */
function postFor(state: VaultState, live: boolean): { door: DoorState; pose: "idle" | "breach"; dim: boolean } {
  if (state === "broken") return { door: "open", pose: "breach", dim: false };
  if (state === "guarding") return { door: live ? "shaking" : "closed", pose: "idle", dim: false };
  return { door: "closed", pose: "idle", dim: true };
}

/**
 * A guard at its post: the vault door behind, the guard in front, on a stone floor inside a dark
 * monitor cell with scanlines. The guard idles (2-frame bob); a live op rattles the door; a breached
 * vault shows the guard slumped by an open door; offline / closed / setting-up vaults go dark.
 * Size is in sprite pixels × `scale` (integer), so it stays crisp.
 *
 * @example <GuardPost castle={c} scale={3} live />
 */
export function GuardPost({
  castle: c,
  scale = 3,
  live = false,
  label,
  className,
}: {
  castle: Pick<Castle, "personality" | "transport" | "guardianName" | "status"> & Partial<Pick<Castle, "vaultState">>;
  scale?: number;
  live?: boolean;
  /** Accessible name; decorative when omitted. */
  label?: string;
  className?: string;
}) {
  const s = Math.max(1, Math.round(scale));
  const kind = guardKind(c);
  const post = postFor(vaultStateOf(c), live);
  const g = guardSprite(kind, post.pose === "breach" ? "breach" : "idle");
  const wide = kind === "paranoid";
  const W = 38 * s;
  const H = 22 * s;
  const floor = 3 * s;
  return (
    <div
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("relative shrink-0 overflow-hidden bg-bg shadow-[inset_0_0_0_2px_var(--color-line)]", className)}
      style={{ width: W, height: H }}
    >
      {/* back wall glow + scanlines */}
      <span className="absolute inset-0 bg-[radial-gradient(ellipse_70%_80%_at_50%_100%,color-mix(in_oklab,var(--color-accent)_10%,transparent),transparent_70%)]" />
      {/* floor */}
      <span className="absolute inset-x-0 bottom-0 bg-raised shadow-[inset_0_2px_0_0_var(--color-line)]" style={{ height: floor }} />
      {/* door */}
      <span className={cn("absolute", post.dim && "opacity-40 grayscale")} style={{ right: 3 * s, bottom: floor }}>
        {post.door === "open" ? (
          <Sprite name="door.open" scale={s} frame={3} />
        ) : post.door === "shaking" ? (
          <Sprite name="door.shaking" scale={s} animate={{ fps: 6, loop: true }} />
        ) : (
          <Sprite name="door.closed" scale={s} />
        )}
      </span>
      {/* guard */}
      <span className={cn("absolute", post.dim && "opacity-50 grayscale")} style={{ left: (wide ? 2 : 4) * s, bottom: floor }}>
        {post.pose === "breach" ? <Sprite name={g.name} scale={s} frame={3} /> : <Sprite name={g.name} scale={s} animate={post.dim ? undefined : g.animate} />}
      </span>
      <span className="scanlines pointer-events-none absolute inset-0 opacity-60" />
    </div>
  );
}

/**
 * Rank chevrons (`rank.0`–`rank.3`) with the rank word. Level 3 (UNBREACHED) carries a star.
 *
 * @example <RankChevrons rank="SENTINEL" />
 */
export function RankChevrons({ rank, level, scale = 1, className, showWord = true }: { rank: string; level: number; scale?: number; className?: string; showWord?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-ui text-[10px] leading-none tracking-[0.12em] text-warn uppercase", className)} title={`Rank: ${rank}`}>
      <Sprite name={`rank.${Math.max(0, Math.min(3, level))}`} scale={scale} />
      {showWord ? <span>{rank}</span> : <span className="sr-only">{rank}</span>}
    </span>
  );
}
