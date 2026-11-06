import type * as React from "react";
import { RotateCw } from "lucide-react";
import { describeError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { LED } from "@/components/pixel/led";
import { panelVariants } from "@/components/pixel/panel";
import { Button } from "./button";

/** Inline error with retry. @example <ErrorState error={error} onRetry={refresh} /> */
export function ErrorState({ error, onRetry, title = "Couldn't load this", className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  return (
    <div role="alert" className={cn(panelVariants({ tone: "threat" }), "flex flex-col items-center gap-3 px-5 py-8 text-center", className)}>
      <LED kind="offline" label="ERROR" />
      <div>
        <p className="font-ui text-sm tracking-[0.06em] text-ink uppercase">{title}</p>
        <p className="mt-1.5 max-w-md text-sm text-ink-dim">{describeError(error)}</p>
      </div>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          <RotateCw /> Retry
        </Button>
      ) : null}
    </div>
  );
}

/** @example <EmptyState title="GRID OFFLINE" hint="No vaults seeded. Run npm run seed." /> */
export function EmptyState({ title, hint, icon, className, children }: { title: string; hint?: React.ReactNode; icon?: React.ReactNode; className?: string; children?: React.ReactNode }) {
  return (
    <div className={cn("flex flex-col items-center gap-2 border-2 border-dashed border-line bg-bg/40 px-5 py-10 text-center", className)}>
      {icon ? <div className="text-ink-dim [&_svg]:size-6">{icon}</div> : null}
      <p className="font-ui text-sm tracking-[0.08em] text-ink uppercase">{title}</p>
      {hint ? <p className="max-w-md text-sm text-ink-dim">{hint}</p> : null}
      {children}
    </div>
  );
}

/** Terminal-style loading line with a blinking block cursor. */
export function Loading({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center gap-1 py-10 font-term text-xl text-ink-dim", className)} role="status">
      <span aria-hidden>&gt;</span> {label}
      <span aria-hidden className="ml-0.5 inline-block h-[0.9em] w-[0.5em] animate-caret bg-current" />
    </div>
  );
}

/** Placeholder block with a scanline sweep. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("shimmer", className)} aria-hidden />;
}
