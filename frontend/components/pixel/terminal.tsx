"use client";

import * as React from "react";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

export type TerminalTone = "ink" | "dim" | "accent" | "money" | "threat" | "safe" | "warn";

const TONE: Record<TerminalTone, string> = {
  ink: "text-ink",
  dim: "text-ink-dim",
  accent: "text-accent",
  money: "text-money",
  threat: "text-threat",
  safe: "text-safe",
  warn: "text-warn",
};

export type TerminalLineData = {
  id?: string | number;
  /** Prompt glyph(s) before the text (default `>`; empty string for none). */
  prompt?: string;
  text: React.ReactNode;
  tone?: TerminalTone;
  /** Right-aligned meta (time, request id). */
  meta?: React.ReactNode;
};

/** One VT323 log line. @example <TerminalLine prompt="$" text="deploy night-sapper" tone="accent" /> */
export function TerminalLine({ prompt = ">", text, tone = "ink", meta, cursor, className }: TerminalLineData & { cursor?: boolean; className?: string }) {
  return (
    <div className={cn("flex items-baseline gap-2", TONE[tone], className)}>
      {prompt ? (
        <span className="shrink-0 text-ink-dim select-none" aria-hidden>
          {prompt}
        </span>
      ) : null}
      <span className="min-w-0 flex-1 break-words">
        {text}
        {cursor ? <Caret /> : null}
      </span>
      {meta != null ? <span className="shrink-0 text-base text-ink-dim">{meta}</span> : null}
    </div>
  );
}

/** Blinking block cursor. */
export function Caret({ className }: { className?: string }) {
  return <span aria-hidden className={cn("ml-0.5 inline-block h-[0.9em] w-[0.55em] translate-y-[0.1em] animate-caret bg-current", className)} />;
}

export type TerminalProps = {
  lines?: TerminalLineData[];
  children?: React.ReactNode;
  /** Show a blinking cursor after the last line (or on an empty prompt line when there are none). */
  cursor?: boolean;
  /** Keep scrolled to the newest line while the user is at the bottom. */
  follow?: boolean;
  /** Accessible name; the log is announced politely. */
  label?: string;
  className?: string;
};

/**
 * Terminal log in VT323 (≥ 18 px). Lines are data or children. With `follow`, new lines scroll into
 * view unless the reader has scrolled up.
 *
 * @example <Terminal follow cursor lines={[{ prompt: "$", text: "recon splinter-gate", tone: "accent" }]} />
 */
export function Terminal({ lines, children, cursor, follow, label = "Log", className }: TerminalProps) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const count = lines?.length ?? 0;

  useEffect(() => {
    const el = ref.current;
    if (follow && el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [follow, count, children]);

  return (
    <div
      ref={ref}
      role="log"
      aria-label={label}
      aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className={cn("scanlines overflow-y-auto bg-bg px-3 py-2 font-term text-[20px] leading-[1.15] text-ink", className)}
    >
      {lines?.map((l, i) => (
        <TerminalLine key={l.id ?? i} {...l} cursor={cursor && !children && i === count - 1} />
      ))}
      {children}
      {cursor && count === 0 && !children ? <TerminalLine text="" cursor /> : null}
    </div>
  );
}
