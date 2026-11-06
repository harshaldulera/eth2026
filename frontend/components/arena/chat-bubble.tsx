"use client";

import { motion, useReducedMotion } from "motion/react";
import { Cpu } from "lucide-react";
import type { SiegeMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { MoveBadge } from "./move-badge";

/**
 * Siege chat bubbles. Raider = ember, right. Guardian = left, with its move and the 0G request id.
 *
 * @example <RaiderBubble text={m.text} turn={m.turn} />
 * @example <GuardianBubble message={m} exposed="authority claim" fresh />
 */
export function RaiderBubble({ text, turn, pending, tactic }: { text: string; turn: number; pending?: boolean; tactic?: string }) {
  const reduced = useReducedMotion();
  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      className="flex flex-col items-end gap-1 pl-8 sm:pl-16"
    >
      <div
        className={cn(
          "max-w-full rounded-2xl rounded-br-md border border-ember/30 bg-ember/[0.12] px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-parchment",
          pending && "opacity-80",
        )}
      >
        {text}
      </div>
      <span className="text-[11px] text-stone">
        Raider · turn {turn}
        {tactic ? <span className="text-ember/80"> · {tactic}</span> : null}
        {pending ? " · sending" : null}
      </span>
    </motion.div>
  );
}

export function GuardianBubble({
  message: m,
  guardianName,
  exposed,
  fresh,
  provider = "0G",
}: {
  message: SiegeMessage;
  guardianName?: string;
  exposed?: string;
  /** Who answered: "0G" by default; the replay passes the recorded provider (e.g. "anthropic"). */
  provider?: string;
  /** Just landed: the request id glows in. */
  fresh?: boolean;
}) {
  const reduced = useReducedMotion();
  const tone =
    m.move === "open"
      ? "border-gold/50 bg-gold/[0.10]"
      : m.move === "banish"
        ? "border-ember/40 bg-arena-raised"
        : "border-arena-line bg-arena-raised";
  return (
    <motion.div
      initial={reduced ? false : m.move === "banish" ? { opacity: 0, x: -12 } : { opacity: 0, y: 8 }}
      animate={m.move === "banish" && !reduced ? { opacity: 1, x: [-12, 6, -3, 0] } : { opacity: 1, x: 0, y: 0 }}
      transition={{ duration: m.move === "banish" ? 0.45 : 0.3 }}
      className="flex flex-col items-start gap-1 pr-8 sm:pr-16"
    >
      <div className={cn("max-w-full rounded-2xl rounded-bl-md border px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-parchment", tone)}>
        {m.text}
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-stone">
        <span>
          {guardianName ?? "Guardian"} · turn {m.turn}
        </span>
        {m.move ? <MoveBadge move={m.move} exposed={exposed} /> : null}
        {m.requestId ? (
          <motion.span
            initial={fresh && !reduced ? { opacity: 0, color: "var(--color-gold)" } : false}
            animate={{ opacity: 1, color: "var(--color-stone)" }}
            transition={{ duration: 1.6 }}
            className="inline-flex items-center gap-1 font-mono text-[10px]"
            title="Request id of this reply, recorded by the arena's model proxy (hashes only)"
          >
            <Cpu className="size-3" aria-hidden />
            {provider} {m.requestId}
          </motion.span>
        ) : null}
      </div>
    </motion.div>
  );
}

export function ThinkingBubble({ guardianName }: { guardianName?: string }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-start gap-1" role="status" aria-live="polite">
      <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-md border border-arena-line bg-arena-raised px-4 py-3.5">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="size-1.5 rounded-full bg-stone"
            animate={{ opacity: [0.3, 1, 0.3] }}
            transition={{ duration: 1, repeat: Infinity, delay: i * 0.18 }}
          />
        ))}
      </div>
      <span className="text-[11px] text-stone">{guardianName ?? "Guardian"} is thinking… · waiting on 0G</span>
    </motion.div>
  );
}
