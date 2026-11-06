"use client";

import type * as React from "react";
import type { Castle } from "@/lib/types";
import { usePixelScale } from "@/lib/pixel/scale";
import { LED } from "@/components/pixel/led";
import { cn } from "@/lib/utils";
import { GuardPost } from "./guard-post";

/**
 * The vault briefing's portrait: the guard at its post, big, inside a CRT monitor bezel with a
 * camera label and a status light. Scale follows the viewport (4 phone, 8 desktop, 10 wall).
 *
 * @example <MonitorPortrait castle={c} live={Boolean(liveOp)} status={<LED kind="safe" />} />
 */
export function MonitorPortrait({
  castle: c,
  live,
  status,
  scale: scaleProp,
  bare,
  className,
}: {
  castle: Castle;
  live?: boolean;
  status?: React.ReactNode;
  scale?: number;
  /** Hide the camera caption (phone band). */
  bare?: boolean;
  className?: string;
}) {
  const px = usePixelScale();
  const scale = scaleProp ?? (px === 2 ? 4 : px === 4 ? 10 : 8);
  return (
    <figure className={cn("relative w-fit max-w-full bg-raised p-2 px-frame sm:p-3", className)}>
      <div className="relative overflow-hidden shadow-[inset_0_0_0_2px_color-mix(in_oklab,var(--color-shade)_60%,transparent)]">
        <GuardPost castle={c} scale={scale} live={live} label={`${c.guardianName} at the door of ${c.name}`} className="shadow-none" />
        {/* glass: vignette + a faint highlight */}
        <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_90%_80%_at_50%_50%,transparent_55%,color-mix(in_oklab,var(--color-shade)_55%,transparent)_100%)]" />
        <span aria-hidden className="pointer-events-none absolute -top-1/3 left-[8%] h-2/3 w-1/3 -rotate-12 bg-ink/[0.04]" />
      </div>
      <figcaption
        className={cn("mt-2 flex w-0 min-w-full items-center justify-between gap-3 font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase", bare && "max-sm:hidden")}
      >
        <span className="truncate">CAM 01 · {c.name}</span>
        {status ?? (live ? <LED kind="live" label="LIVE OP" /> : null)}
      </figcaption>
    </figure>
  );
}
