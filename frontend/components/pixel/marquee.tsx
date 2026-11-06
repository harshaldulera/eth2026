import * as React from "react";
import { cn } from "@/lib/utils";

export type MarqueeProps = {
  children: React.ReactNode;
  /** Seconds for one full loop (default 40). */
  duration?: number;
  /** Accessible name for the region. */
  label?: string;
  className?: string;
  /** Classes for each copy of the content row. */
  rowClassName?: string;
};

/**
 * LED ticker: content scrolls right-to-left, pauses on hover/focus. Under reduced motion it stands
 * still and becomes horizontally scrollable. Pure CSS (no timers), so it's free in hidden routes.
 *
 * @example <Marquee label="Recent events">{events.map((e) => <EventLine key={e.id} event={e} />)}</Marquee>
 */
export function Marquee({ children, duration = 40, label = "Ticker", className, rowClassName }: MarqueeProps) {
  return (
    <div
      role="region"
      aria-label={label}
      className={cn(
        "px-marquee relative overflow-hidden border-y-2 border-line bg-bg/80 font-term text-lg text-ink motion-reduce:overflow-x-auto",
        "[mask-image:linear-gradient(90deg,transparent,black_4%,black_96%,transparent)]",
        className,
      )}
      style={{ "--marquee-duration": `${duration}s` } as React.CSSProperties}
    >
      <div className="px-marquee-track flex w-max">
        <div className={cn("flex shrink-0 items-center gap-8 py-1.5 pr-8", rowClassName)}>{children}</div>
        <div className={cn("flex shrink-0 items-center gap-8 py-1.5 pr-8", rowClassName)} aria-hidden inert>
          {children}
        </div>
      </div>
    </div>
  );
}
