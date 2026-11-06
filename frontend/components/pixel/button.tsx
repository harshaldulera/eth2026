"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { playCue } from "./sfx-link";

/** Framed key: bevel that presses in. */
const KEY = "px-key active:px-key-down aria-pressed:px-key-down";
const frame = (c: string) => `${KEY} [--frame:color-mix(in_oklab,var(--color-${c})_45%,black)]`;
const threatLine = `${KEY} bg-panel text-threat [--frame:color-mix(in_oklab,var(--color-threat)_70%,var(--color-line))]`;

export const pixelButtonVariants = cva(
  "relative inline-flex max-w-full items-center justify-center gap-2 text-center font-ui tracking-[0.04em] select-none transition-[filter,transform] duration-75 hover:brightness-110 active:translate-y-[2px] aria-pressed:translate-y-[2px] disabled:pointer-events-none disabled:opacity-45 disabled:saturate-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        /** money action: pay, run an op */
        money: cn("bg-money text-bg", frame("money")),
        /** hold / approve */
        safe: cn("bg-safe text-bg", frame("safe")),
        /** attack / deny, solid */
        threat: cn("bg-threat text-bg", frame("threat")),
        /** attack / deny, outlined */
        threatOutline: threatLine,
        outline: cn(KEY, "bg-raised text-ink"),
        ghost: "bg-transparent text-ink-dim hover:bg-ink/5 hover:text-ink aria-pressed:bg-ink/10 aria-pressed:text-ink",
        // legacy names (components/ui/button.tsx keeps its props)
        gold: cn("bg-money text-bg", frame("money")),
        ward: cn("bg-safe text-bg", frame("safe")),
        ember: threatLine,
        emberSolid: cn("bg-threat text-bg", frame("threat")),
      },
      size: {
        sm: "min-h-8 px-3 py-1 text-[11px] leading-tight",
        md: "min-h-10 px-4 py-1.5 text-xs leading-tight",
        lg: "min-h-12 px-5 py-2 text-xs leading-tight sm:text-[13px]",
        /** 56px thumb target (phone approvals, Op room send) */
        xl: "min-h-14 px-6 py-2 text-base leading-tight [&_svg]:size-5",
        icon: "size-9 shrink-0 text-xs leading-none",
      },
    },
    defaultVariants: { variant: "outline", size: "md" },
  },
);

export type PixelButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof pixelButtonVariants> & {
    /** Held-down look (toggles); also sets aria-pressed. */
    pressed?: boolean;
    /** Sound cue on click (`lib/sfx` name). Default `ui_blip`; `null` for silence. */
    cue?: string | null;
  };

/**
 * Chunky key with a pixel bevel that presses in. Sizes up to xl = 56 px.
 *
 * @example <PixelButton variant="money" size="xl" cue="coin_pay" onClick={pay}>RUN OP — PAY 1 ℏ VIA x402</PixelButton>
 */
export function PixelButton({
  className,
  variant,
  size,
  pressed,
  cue = "ui_blip",
  type = "button",
  onClick,
  ...props
}: PixelButtonProps) {
  return (
    <button
      type={type}
      aria-pressed={pressed}
      className={cn(pixelButtonVariants({ variant, size }), className)}
      onClick={(e) => {
        playCue(cue);
        onClick?.(e);
      }}
      {...props}
    />
  );
}
