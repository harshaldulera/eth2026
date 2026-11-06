import type * as React from "react";
import { AlertTriangle, Loader2, RotateCw } from "lucide-react";
import { describeError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import { Button } from "./button";

/** Inline error with retry. @example <ErrorState error={error} onRetry={refresh} /> */
export function ErrorState({ error, onRetry, title = "Couldn't load this", className }: { error: unknown; onRetry?: () => void; title?: string; className?: string }) {
  return (
    <div role="alert" className={cn("flex flex-col items-center gap-3 rounded-2xl border border-ember/25 bg-ember/[0.04] px-5 py-8 text-center", className)}>
      <AlertTriangle className="size-5 text-ember" aria-hidden />
      <div>
        <p className="font-medium text-parchment">{title}</p>
        <p className="mt-1 max-w-md text-sm text-stone">{describeError(error)}</p>
      </div>
      {onRetry ? (
        <Button size="sm" onClick={onRetry}>
          <RotateCw /> Retry
        </Button>
      ) : null}
    </div>
  );
}

/** @example <EmptyState title="No castles yet" hint="run npm run seed" /> */
export function EmptyState({ title, hint, icon, className, children }: { title: string; hint?: React.ReactNode; icon?: React.ReactNode; className?: string; children?: React.ReactNode }) {
  return (
    <div className={cn("flex flex-col items-center gap-2 rounded-2xl border border-dashed border-arena-line px-5 py-10 text-center", className)}>
      {icon ? <div className="text-stone [&_svg]:size-6">{icon}</div> : null}
      <p className="font-medium text-parchment">{title}</p>
      {hint ? <p className="max-w-md text-sm text-stone">{hint}</p> : null}
      {children}
    </div>
  );
}

export function Loading({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div className={cn("flex items-center justify-center gap-2 py-10 text-sm text-stone", className)} role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}
    </div>
  );
}

/** Pulsing placeholder block. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("shimmer rounded-xl", className)} aria-hidden />;
}
