"use client";

import type * as React from "react";
import { cn } from "@/lib/utils";
import { playCue } from "@/components/pixel/sfx-link";

/**
 * Pixel toggle chip (sort and filter rows). Pressed = lit accent key; plays `ui_blip` on change.
 *
 * @example <Chip active={order === "pot"} onClick={() => setOrder("pot")}>BIGGEST POT</Chip>
 */
export function Chip({
  active,
  onClick,
  title,
  children,
  className,
}: {
  active: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-pressed={active}
      onClick={() => {
        if (!active) playCue("ui_blip");
        onClick();
      }}
      className={cn(
        "inline-flex min-h-8 shrink-0 items-center px-2.5 py-1 font-ui text-[11px] leading-none tracking-[0.08em] whitespace-nowrap uppercase transition-[color,background-color,box-shadow] duration-75",
        active
          ? "bg-accent text-bg shadow-[0_0_0_2px_var(--color-accent),0_0_10px_-2px_var(--color-accent)]"
          : "bg-panel text-ink-dim shadow-[inset_0_0_0_2px_var(--color-line)] hover:text-ink hover:shadow-[inset_0_0_0_2px_color-mix(in_oklab,var(--color-accent)_45%,var(--color-line))]",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Label + chips. On phones the row scrolls sideways instead of wrapping. */
export function ChipGroup({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)} role="group" aria-label={label}>
      <span className="shrink-0 font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">{label}</span>
      <div className="-my-1 flex min-w-0 gap-2 overflow-x-auto px-0.5 py-1 [scrollbar-width:none]">{children}</div>
    </div>
  );
}
