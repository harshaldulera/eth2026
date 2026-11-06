"use client";

import { motion, useReducedMotion } from "motion/react";
import { DoorClosed, DoorOpen, ScanEye, Shield } from "lucide-react";
import type { GuardianMove } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The guardian's move on a reply: Hold (shield), Expose (names the trick), Banish (gate slams),
 * Open (vault opens).
 *
 * @example <MoveBadge move="expose" exposed="authority claim" />
 */
export function MoveBadge({ move, exposed, className }: { move: GuardianMove; exposed?: string; className?: string }) {
  const reduced = useReducedMotion();
  const base = "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium [&_svg]:size-3";
  if (move === "hold")
    return (
      <span className={cn(base, "border-ward/30 bg-ward/10 text-ward", className)}>
        <Shield aria-hidden /> Hold
      </span>
    );
  if (move === "expose")
    return (
      <span className={cn(base, "border-gold/30 bg-gold/10 text-gold", className)}>
        <ScanEye aria-hidden /> Exposed{exposed ? <span className="text-parchment/90">: {exposed}</span> : null}
      </span>
    );
  if (move === "banish")
    return (
      <motion.span
        initial={reduced ? false : { y: -10, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: "spring", stiffness: 700, damping: 18 }}
        className={cn(base, "border-ember/40 bg-ember/15 text-ember", className)}
      >
        <DoorClosed aria-hidden /> Banished — gate slammed
      </motion.span>
    );
  return (
    <span className={cn(base, "border-gold/50 bg-gold/20 text-gold", className)}>
      <DoorOpen aria-hidden /> Opens the vault
    </span>
  );
}
