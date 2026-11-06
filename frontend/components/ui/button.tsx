import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 rounded-xl font-medium whitespace-nowrap transition-[background-color,border-color,color,transform,opacity] select-none active:scale-[0.98] disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        /** money action: pay, lay siege */
        gold: "bg-gold text-arena-bg hover:bg-[#ffd36b] shadow-[0_0_0_1px_rgb(245_196_81/0.4),0_8px_24px_-8px_rgb(245_196_81/0.5)]",
        /** approve / hold */
        ward: "bg-ward text-arena-bg hover:bg-[#7cf0b6]",
        /** attack / deny, outline */
        ember: "border border-ember/70 text-ember hover:bg-ember/10",
        emberSolid: "bg-ember text-arena-bg hover:bg-[#ff7556]",
        outline: "border border-arena-line text-parchment hover:border-stone/60 hover:bg-white/[0.03]",
        ghost: "text-stone hover:text-parchment hover:bg-white/[0.04]",
      },
      size: {
        sm: "h-8 px-3 text-sm",
        md: "h-10 px-4 text-sm",
        lg: "h-12 px-5 text-base",
        /** 56px thumb target (phone approvals) */
        xl: "h-14 px-6 text-lg [&_svg]:size-5",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "outline", size: "md" },
  },
);

export type ButtonProps = React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

/** @example <Button variant="gold" size="lg" onClick={pay}>Lay siege</Button> */
export function Button({ className, variant, size, type = "button", ...props }: ButtonProps) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
