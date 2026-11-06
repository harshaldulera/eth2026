"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { pixelButtonVariants } from "@/components/pixel/button";
import { Caret } from "@/components/pixel/terminal";
import type { SceneFrame } from "@/lib/scene/player";
import { BUTTONS, STAMPS } from "@/lib/vocab";
import { cn } from "@/lib/utils";

const shortHash = (h?: string) => (h ? (h.length > 14 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h) : "");

export type FrozenBarProps = {
  frame: SceneFrame;
  opId: string;
  /** Right side extras (run another op, …). */
  children?: ReactNode;
  /** Hide the REPLAY button (the replay page itself). */
  noReplay?: boolean;
  className?: string;
};

/**
 * The end of every op: `FROZEN · 0x3caa…6213` types out while the scene desaturates, then
 * `REPLAY ▶` (to /replay/[id]) takes the composer's place.
 *
 * @example {frame.ended ? <FrozenBar frame={frame} opId={siege.id} /> : null}
 */
export function FrozenBar({ frame: f, opId, children, noReplay, className }: FrozenBarProps) {
  const full = STAMPS.frozen(shortHash(f.transcriptHash) || "transcript sealed");
  const n = Math.ceil(full.length * Math.min(1, f.freeze));
  const done = n >= full.length;
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-3 bg-raised px-3 py-2.5 px-frame", className)}>
      <p className="min-w-0 font-term text-[22px] leading-none tracking-wide text-ink" title={f.transcriptHash}>
        {full.slice(0, n)}
        {!done ? <Caret /> : null}
      </p>
      <div className={cn("flex flex-wrap items-center gap-2 transition-opacity", done ? "opacity-100" : "opacity-0")}>
        {children}
        {!noReplay ? (
          <Link href={`/replay/${opId}`} className={pixelButtonVariants({ variant: "money", size: "lg" })}>
            {BUTTONS.replay}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
