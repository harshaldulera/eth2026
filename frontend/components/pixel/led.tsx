import * as React from "react";
import { cn } from "@/lib/utils";
import { LED as LED_TEXT } from "@/lib/vocab";

export type LedKind = "stub" | "testnet" | "offline" | "live" | "idle" | "warn" | "safe" | "money";

const KIND: Record<LedKind, { dot: string; text: string; anim?: string; label: string }> = {
  stub: { dot: "bg-money", text: "text-money", label: LED_TEXT.stub },
  testnet: { dot: "bg-safe", text: "text-safe", anim: "animate-led", label: LED_TEXT.testnet },
  offline: { dot: "bg-threat", text: "text-threat", label: LED_TEXT.apiOffline },
  live: { dot: "bg-threat", text: "text-threat", anim: "animate-blink", label: LED_TEXT.live },
  idle: { dot: "bg-ink-dim", text: "text-ink-dim", label: LED_TEXT.idle },
  warn: { dot: "bg-warn", text: "text-warn", anim: "animate-blink", label: "WARN" },
  safe: { dot: "bg-safe", text: "text-safe", label: LED_TEXT.guarding },
  money: { dot: "bg-money", text: "text-money", label: "" },
};

export type LedProps = {
  kind: LedKind;
  /** Text after the light; defaults per kind (`STUB`, `TESTNET`, `API OFFLINE`, `LIVE`, `IDLE`). `false` for the light alone. */
  label?: React.ReactNode | false;
  /** Override the kind's blink/pulse. */
  blink?: boolean;
  /** Boxed chip (HUD) instead of a bare light + text. */
  boxed?: boolean;
  title?: string;
  className?: string;
};

/**
 * Status light. Square, glowing, in the role colour; `live` blinks, `testnet` pulses, `stub`
 * sits in a dashed amber box when boxed.
 *
 * @example <LED kind="testnet" boxed /> <LED kind="live" label="LIVE · 3/5" />
 */
export function LED({ kind, label, blink, boxed, title, className }: LedProps) {
  const k = KIND[kind];
  const text = label === false ? null : (label ?? k.label);
  const anim = blink === false ? undefined : blink ? "animate-blink" : k.anim;
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 font-ui text-[11px] leading-none tracking-[0.1em] whitespace-nowrap uppercase",
        k.text,
        boxed && "border-2 bg-bg/60 px-2 py-1",
        boxed && (kind === "stub" ? "border-dashed border-money/70" : "border-current/40"),
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("size-2 shrink-0 shadow-[0_0_6px_currentColor]", k.dot, anim)}
      />
      {text ? <span>{text}</span> : null}
    </span>
  );
}
