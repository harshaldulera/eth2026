import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Pixel chip: square, 1px frame, Silkscreen caps. Tones keep their Part 1 names. */
export const badgeVariants = cva(
  "inline-flex items-center gap-1 border px-1.5 py-[3px] font-ui text-[10px] leading-3 tracking-[0.08em] whitespace-nowrap uppercase [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "border-line bg-bg/40 text-ink-dim",
        gold: "border-money/45 bg-money/10 text-money",
        ember: "border-threat/50 bg-threat/10 text-threat",
        ward: "border-safe/45 bg-safe/10 text-safe",
        parchment: "border-ink/30 bg-ink/5 text-ink",
        stub: "border-dashed border-ink-dim/60 bg-transparent text-ink-dim",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeProps = React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

/** @example <Badge tone="ward"><Shield /> Held</Badge> */
export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
