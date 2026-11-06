import * as React from "react";
import { cn } from "@/lib/utils";
import { LED } from "./led";

export type PagerProps = {
  /** LCD header text, e.g. `PAGER · 1 WAITING`. */
  title: React.ReactNode;
  /** Alert light: lit and blinking while something waits. */
  alert?: boolean;
  /** Right side of the header strip (owner key state, notification toggle). */
  action?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
};

/**
 * The owner's pager: a bevelled device with an LCD header and an alert LED. Phone-first; the card
 * stack goes in `children`.
 *
 * @example <Pager title="PAGER · 1 WAITING" alert><ApprovalCard … /></Pager>
 */
export function Pager({ title, alert, action, children, className }: PagerProps) {
  return (
    <section
      className={cn(
        "relative mx-auto w-full max-w-md bg-raised p-3 pb-5 px-frame [--frame:color-mix(in_oklab,var(--color-line)_70%,black)] sm:p-4 sm:pb-6",
        className,
      )}
    >
      <div className="mb-3 flex items-center justify-between gap-2 px-1">
        <span className="font-ui text-[10px] tracking-[0.3em] text-ink-dim uppercase">Siege · Pager</span>
        <LED kind={alert ? "warn" : "idle"} label={alert ? "ALERT" : "READY"} />
      </div>
      <div
        className={cn(
          "flex items-center justify-between gap-3 border-2 border-line bg-[color-mix(in_oklab,var(--color-accent)_10%,var(--color-bg))] px-3 py-2",
          "shadow-[inset_0_0_14px_color-mix(in_oklab,var(--color-shade)_60%,transparent)]",
        )}
      >
        <h1 className="font-term text-2xl leading-none tracking-wide text-accent uppercase glow">{title}</h1>
        {action}
      </div>
      <div className="mt-4 flex flex-col gap-4">{children}</div>
      <div className="mt-5 flex justify-center gap-1.5" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className="h-1 w-6 bg-bg/60" />
        ))}
      </div>
    </section>
  );
}
