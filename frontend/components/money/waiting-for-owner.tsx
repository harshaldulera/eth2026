"use client";

import { Hourglass, Smartphone } from "lucide-react";
import type { ApprovalRequest, Asset } from "@/lib/types";
import { formatElapsed, HBAR } from "@/lib/money/format";
import { useNow } from "@/lib/hooks/usePolling";
import { cn } from "@/lib/utils";
import { Amount } from "./amount";
import { reasonText } from "./approval-card";

export type WaitingForOwnerProps = {
  approval: ApprovalRequest;
  /** When the wait began (ISO or unix ms); defaults to approval.createdAt. */
  since?: string | number;
  asset?: Asset;
  className?: string;
};

/**
 * Inline "paused, waiting for the human" block for an agent that hit a cap.
 *
 * @example <WaitingForOwner approval={pendingApproval} />
 */
export function WaitingForOwner({ approval, since, asset = HBAR, className }: WaitingForOwnerProps) {
  const now = useNow(1000);
  const start = typeof since === "number" ? since : Date.parse(since ?? approval.createdAt);
  const elapsed = Number.isFinite(start) && now > 0 ? (now - start) / 1000 : 0;
  return (
    <div className={cn("rounded-2xl border border-gold/30 bg-gold/[0.04] p-4", className)} role="status" aria-live="polite">
      <div className="flex items-start gap-3.5">
        <span className="relative mt-0.5 grid size-10 shrink-0 place-items-center">
          <span className="absolute inset-0 animate-ring rounded-full border-2 border-gold/70" aria-hidden />
          <span className="absolute inset-0 rounded-full border border-gold/40 bg-gold/10" aria-hidden />
          <Smartphone className="relative size-4.5 text-gold" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="font-medium text-parchment">Waiting for owner</p>
            <span className="tabular flex items-center gap-1 text-xs text-gold">
              <Hourglass className="size-3" aria-hidden />
              waiting {formatElapsed(elapsed)}
            </span>
          </div>
          <p className="mt-0.5 text-sm text-stone">
            {approval.agentName} {reasonText(approval).replace(/^./, (c) => c.toLowerCase())}.
          </p>
          {approval.reasoning ? (
            <blockquote className="mt-3 border-l-2 border-ember/60 pl-3 text-sm text-parchment/90 italic">
              &ldquo;{approval.reasoning}&rdquo;
            </blockquote>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="text-stone">
              Asking for <Amount amount={approval.amount} asset={asset} />
            </span>
            <span className="text-parchment/80">Your agent wants to keep going. Only you can let it.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
