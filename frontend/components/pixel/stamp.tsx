"use client";

import * as React from "react";
import { motion } from "motion/react";
import { useCalmMotion } from "@/lib/hooks/usePrefs";
import { cn } from "@/lib/utils";
import { stampText, type StampKind } from "@/lib/vocab";

export type { StampKind };

const KIND: Record<StampKind, string> = {
  hold: "text-stamp-hold",
  flag: "text-stamp-flag",
  lockdown: "text-stamp-lockdown",
  breach: "text-stamp-breach",
};

const SIZE = {
  sm: "px-2 py-1 text-[14px] border-2",
  md: "px-3 py-2 text-base border-[3px]",
  lg: "px-4 py-2.5 text-xl border-4",
  xl: "px-5 py-3 text-2xl border-4 sm:text-3xl",
  wall: "px-8 py-5 text-[64px] border-8",
  /** Long FLAG lines on the wall: one or two lines, not three. */
  wallSm: "px-6 py-4 text-[36px] leading-tight border-[6px]",
  /** BREACH on the wall: the one stamp drawn at 2×. */
  wallXl: "px-7 py-2 text-[72px] border-8",
} as const;

export type StampProps = {
  kind: StampKind;
  /** Override the text; defaults to the copy deck (`ACCESS DENIED`, `FLAGGED · CLASS`, …). */
  children?: React.ReactNode;
  /** Class name for FLAG stamps (`AUTHORITY IMPERSONATION`). */
  cls?: string;
  /** SDK guards: `FLAGGED (referee) · label`. */
  referee?: boolean;
  size?: keyof typeof SIZE;
  /** Slam in on mount (default). False renders it already landed (replay scrubbing, lists). */
  slam?: boolean;
  /** Tilt in degrees (default −6). */
  tilt?: number;
  className?: string;
};

/**
 * The verdict. Rubber-stamp frame in the move colour that slams in (scale 1.6 → 1 with a slight
 * overshoot). Reduced motion: no scale, it just appears. Announced politely to screen readers.
 *
 * @example <Stamp kind="flag" cls="authority impersonation" />
 */
export function Stamp({ kind, children, cls, referee, size = "md", slam = true, tilt: tiltProp, className }: StampProps) {
  const tilt = tiltProp ?? -6;
  const still = useCalmMotion();
  const text = children ?? stampText(kind, cls, { referee });
  const animate = slam && !still;
  return (
    <motion.div
      role="status"
      aria-live="polite"
      initial={animate ? { scale: 1.6, opacity: 0, rotate: tilt } : slam ? { opacity: 0, rotate: tilt } : false}
      animate={{ scale: 1, opacity: 1, rotate: tilt }}
      transition={animate ? { type: "spring", stiffness: 900, damping: 26, mass: 0.6 } : { duration: 0.12 }}
      style={{ rotate: tilt }}
      className={cn(
        "relative inline-flex w-fit origin-center items-center justify-center border-current bg-bg/60 font-pixel leading-none tracking-wide whitespace-nowrap uppercase",
        "[text-shadow:0_0_8px_color-mix(in_oklab,currentColor_55%,transparent)] shadow-[0_0_14px_-2px_color-mix(in_oklab,currentColor_60%,transparent),inset_0_0_10px_-4px_currentColor]",
        "outline-1 outline-offset-[-6px] outline-current/40 outline-dashed",
        KIND[kind],
        SIZE[size],
        className,
      )}
    >
      {text}
    </motion.div>
  );
}
