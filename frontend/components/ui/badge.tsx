import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "border-arena-line bg-white/[0.03] text-stone",
        gold: "border-gold/30 bg-gold/10 text-gold",
        ember: "border-ember/35 bg-ember/10 text-ember",
        ward: "border-ward/30 bg-ward/10 text-ward",
        parchment: "border-parchment/20 bg-parchment/5 text-parchment",
        stub: "border-dashed border-stone/50 bg-transparent text-stone",
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
