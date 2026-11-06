"use client";

import { Stamp as StampPrimitive, type StampProps } from "@/components/pixel/stamp";
import type { Stamp } from "@/lib/scene/classes";
import { cn } from "@/lib/utils";

export type MoveStampProps = {
  stamp: Stamp;
  size?: StampProps["size"];
  /** Slam in on mount (default). False: already landed (scrubbing, lists). */
  slam?: boolean;
  /** Tilt in degrees (default −6). */
  tilt?: number;
  className?: string;
};

/**
 * The verdict stamp for a guard move, from the scene's `Stamp` (lib/scene/classes):
 * ACCESS DENIED · FLAGGED · <CLASS> · SESSION TERMINATED · BREACH. SDK flags print "(referee)".
 *
 * @example <MoveStamp stamp={msg.stamp} />
 */
export function MoveStamp({ stamp, size = "md", slam = true, tilt, className }: MoveStampProps) {
  return (
    <StampPrimitive
      kind={stamp.kind}
      size={size}
      slam={slam}
      tilt={tilt}
      className={cn(
        "max-w-full whitespace-normal",
        size === "md" && "max-sm:border-2 max-sm:px-2 max-sm:py-1.5 max-sm:text-[14px] max-sm:leading-snug",
        size === "xl" && "max-sm:border-[3px] max-sm:px-3 max-sm:py-2 max-sm:text-xl",
        className,
      )}
    >
      {stamp.text}
    </StampPrimitive>
  );
}
