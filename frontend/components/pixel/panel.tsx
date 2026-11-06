import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const panelVariants = cva("relative text-ink px-frame", {
  variants: {
    tone: {
      default: "bg-panel",
      raised: "bg-raised",
      inset: "bg-bg [--bevel-hi:color-mix(in_oklab,var(--color-shade)_45%,transparent)] [--bevel-lo:var(--bevel-hi)]",
      accent: "bg-panel [--frame:color-mix(in_oklab,var(--color-accent)_55%,var(--color-line))]",
      money: "bg-panel [--frame:color-mix(in_oklab,var(--color-money)_55%,var(--color-line))]",
      threat: "bg-panel [--frame:color-mix(in_oklab,var(--color-threat)_60%,var(--color-line))]",
      safe: "bg-panel [--frame:color-mix(in_oklab,var(--color-safe)_55%,var(--color-line))]",
      warn: "bg-panel [--frame:color-mix(in_oklab,var(--color-warn)_55%,var(--color-line))]",
      ghost: "bg-transparent shadow-none [--frame:transparent]",
    },
  },
  defaultVariants: { tone: "default" },
});

export type PanelTone = NonNullable<VariantProps<typeof panelVariants>["tone"]>;

/** Title-bar square colour per tone. */
export const PANEL_DOT: Record<PanelTone, string> = {
  default: "bg-accent",
  raised: "bg-accent",
  inset: "bg-ink-dim",
  accent: "bg-accent",
  money: "bg-money",
  threat: "bg-threat",
  safe: "bg-safe",
  warn: "bg-warn",
  ghost: "bg-ink-dim",
};

export type PixelPanelProps = Omit<React.ComponentProps<"div">, "title"> &
  VariantProps<typeof panelVariants> & {
    /** Title bar text (Silkscreen, uppercase). Omit for a bare frame. */
    title?: React.ReactNode;
    /** Right side of the title bar (a link, an LED, a count). */
    action?: React.ReactNode;
    icon?: React.ReactNode;
    /** Classes for the body wrapper when a title bar is shown. */
    bodyClassName?: string;
  };

/**
 * Bevelled pixel frame, optionally with a title bar. Pure CSS (no images), so it ships without
 * the sprite pack and reskins with the tokens.
 *
 * @example <PixelPanel title="Recent ops" tone="money" action={<LED kind="live" />}>…</PixelPanel>
 */
export function PixelPanel({ tone, title, action, icon, bodyClassName, className, children, ...props }: PixelPanelProps) {
  const t = (tone ?? "default") as PanelTone;
  return (
    <div className={cn(panelVariants({ tone }), className)} {...props}>
      {title != null ? (
        <>
          <PanelTitle title={title} action={action} icon={icon} dot={PANEL_DOT[t]} />
          <div className={bodyClassName}>{children}</div>
        </>
      ) : (
        children
      )}
    </div>
  );
}

/** The title strip on its own (Card's header uses it). */
export function PanelTitle({
  title,
  action,
  icon,
  dot = "bg-accent",
  className,
}: {
  title: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  dot?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-9 items-center justify-between gap-3 border-b-2 border-line bg-raised/70 px-3 py-1.5",
        className,
      )}
    >
      <h2 className="flex items-center gap-2 font-ui text-xs tracking-[0.12em] text-ink-dim uppercase [&_svg]:size-3.5 [&_svg]:shrink-0">
        {icon ?? <span className={cn("size-2 shrink-0", dot)} aria-hidden />}
        <span>{title}</span>
      </h2>
      {/* contain:inline-size: a long action (a topic id) never widens the column; it truncates instead */}
      {action ? <div className="flex min-w-0 flex-1 items-center justify-end gap-2 text-xs [contain:inline-size]">{action}</div> : null}
    </div>
  );
}
