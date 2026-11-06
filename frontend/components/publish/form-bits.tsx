"use client";

import type * as React from "react";
import { PUBLISH } from "@/lib/vocab";
import { cn } from "@/lib/utils";
import { PixelButton } from "@/components/pixel/button";
import { Sprite } from "@/components/pixel/sprite";

export const field =
  "min-h-11 w-full border-2 border-line bg-bg px-2.5 font-term text-[20px] leading-none text-ink focus:border-accent focus:outline-none";
export const labelCls = "mb-1 block font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase";

/** Label + control + hint/error, one block. */
export function Field({ label, hint, error, children, className }: { label: string; hint?: React.ReactNode; error?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className={labelCls}>{label}</span>
      {children}
      {error ? (
        <span role="alert" className="mt-1 block text-[12px] text-threat">
          {error}
        </span>
      ) : hint ? (
        <span className="mt-1 block text-[12px] leading-snug text-ink-dim">{hint}</span>
      ) : null}
    </label>
  );
}

/** Text input with an optional suffix (ℏ). */
export function TextInput({
  value,
  onChange,
  placeholder,
  invalid,
  suffix,
  inputMode,
  maxLength,
  className,
  ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  invalid?: boolean;
  suffix?: string;
  inputMode?: "decimal" | "text";
  maxLength?: number;
  className?: string;
} & Omit<React.ComponentProps<"input">, "value" | "onChange">) {
  return (
    <span className="relative block">
      <input
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode={inputMode}
        maxLength={maxLength}
        spellCheck={false}
        className={cn(field, suffix && "tabular pr-8 text-money", invalid && "border-threat", className)}
      />
      {suffix ? <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-money/80">{suffix}</span> : null}
    </span>
  );
}

const SPRITE_FOR: Record<string, string> = { professional: "support-bot" };

/** The voice radio cards with each voice's guard sprite. */
export function VoicePicker({ value, onChange, voices }: { value: string; onChange: (v: string) => void; voices: readonly string[] }) {
  return (
    <div role="radiogroup" aria-label={PUBLISH.voice} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {voices.map((v) => {
        const on = v === value;
        const copy = PUBLISH.voices[v];
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(v)}
            className={cn(
              "flex min-w-0 items-center gap-2.5 border-2 bg-bg px-2 py-2 text-left transition-colors",
              on ? "border-accent bg-raised shadow-[0_0_10px_-3px_var(--color-accent)]" : "border-line hover:border-ink-dim",
            )}
          >
            <Sprite name={`guard.${SPRITE_FOR[v] ?? v}.idle`} scale={2} animate={on} />
            <span className="min-w-0">
              <span className={cn("block font-ui text-[11px] tracking-[0.1em] uppercase", on ? "text-accent" : "text-ink")}>{copy?.label ?? v}</span>
              <span className="mt-0.5 block text-[12px] leading-tight text-ink-dim">{copy?.sample}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Numbered step chips; finished steps are clickable. */
export function StepChips({ labels, step, onGo }: { labels: readonly string[]; step: number; onGo: (i: number) => void }) {
  return (
    <ol className="flex flex-wrap gap-1.5 sm:gap-2" aria-label="Steps">
      {labels.map((l, i) => {
        const done = i < step;
        const on = i === step;
        return (
          <li key={l} className="min-w-0">
            <button
              type="button"
              disabled={!done}
              aria-current={on ? "step" : undefined}
              onClick={() => onGo(i)}
              className={cn(
                "flex min-h-9 items-center gap-2 border-2 px-2.5 py-1 font-ui text-[11px] tracking-[0.1em] whitespace-nowrap uppercase",
                on ? "border-accent bg-raised text-ink" : done ? "border-safe/60 text-safe hover:bg-raised/50" : "border-line text-ink-dim",
              )}
            >
              <span aria-hidden className={cn("grid size-5 place-items-center text-[11px] leading-none", on ? "bg-accent text-bg" : done ? "bg-safe text-bg" : "bg-line text-ink-dim")}>
                {done ? "✓" : i + 1}
              </span>
              {l}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** BACK / NEXT bar. */
export function StepNav({ onBack, onNext, nextLabel, backLabel, nextDisabled, children }: { onBack?: () => void; onNext?: () => void; nextLabel?: string; backLabel?: string; nextDisabled?: boolean; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t-2 border-dashed border-line pt-4">
      {onBack ? (
        <PixelButton variant="ghost" onClick={onBack}>
          {backLabel ?? PUBLISH.back}
        </PixelButton>
      ) : (
        <span />
      )}
      {children}
      {onNext ? (
        <PixelButton variant="money" size="lg" disabled={nextDisabled} onClick={onNext}>
          {nextLabel ?? PUBLISH.next}
        </PixelButton>
      ) : null}
    </div>
  );
}
