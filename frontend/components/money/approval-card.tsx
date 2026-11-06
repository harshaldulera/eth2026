"use client";

import { Check, Loader2, ShieldCheck, ShieldX, X } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import type { ApprovalRequest, Asset } from "@/lib/types";
import { HBAR, timeAgo } from "@/lib/money/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Amount } from "./amount";
import { HashscanLink } from "./hashscan-link";
import { PressureMeter } from "./pressure-meter";

/** Why an agent paused, in plain words. */
export function reasonText(a: Pick<ApprovalRequest, "reason" | "castleName">): string {
  switch (a.reason) {
    case "per_castle":
      return `Hit its per-castle cap on ${a.castleName}`;
    case "daily":
      return "Hit its daily spending cap";
    case "budget":
      return "Ran out of budget";
    case "stop_rule":
      return "Lost too many sieges in a row — its stop rule kicked in";
    case "stopped":
      return "Was stopped and wants to resume";
    default:
      return "Needs your go-ahead";
  }
}

export type ApprovalCardProps = {
  approval: ApprovalRequest;
  onDecide?: (decision: "approved" | "denied") => void;
  /** true while a decision is in flight; or the decision being sent (spinner on that button). */
  busy?: boolean | "approved" | "denied";
  asset?: Asset;
  className?: string;
};

/**
 * The owner's decision card (phone-first). Pending: two 56px thumb buttons. Decided: the outcome
 * and the on-chain top-up link.
 *
 * @example <ApprovalCard approval={a} onDecide={(d) => decide(a.id, d)} busy={sending} />
 */
export function ApprovalCard({ approval: a, onDecide, busy, asset = HBAR, className }: ApprovalCardProps) {
  const reduced = useReducedMotion();
  const pending = a.status === "pending";
  const isBusy = Boolean(busy);
  return (
    <motion.article
      layout={!reduced}
      initial={reduced ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "rounded-2xl border bg-arena-panel p-4 sm:p-5",
        pending ? "border-gold/40 shadow-[0_0_0_1px_rgb(245_196_81/0.12),0_18px_40px_-20px_rgb(245_196_81/0.35)]" : "border-arena-line",
        className,
      )}
      aria-label={`Approval request from ${a.agentName}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs tracking-wide text-stone uppercase">
            {a.agentName} · {timeAgo(a.createdAt)}
          </p>
          <h3 className="mt-1 text-lg leading-snug font-semibold text-parchment">{a.castleName}</h3>
          <p className="mt-0.5 text-[15px] text-parchment/80">{reasonText(a)}</p>
        </div>
        {!pending ? <DecisionBadge status={a.status} /> : null}
      </header>

      <PressureMeter value={a.pressure} label="Pressure reached" className="mt-4" size="lg" />

      {a.reasoning ? (
        <blockquote className="mt-4 rounded-xl border-l-2 border-ember/60 bg-ember/[0.04] py-2.5 pr-3 pl-3.5 text-[15px] leading-relaxed text-parchment/90 italic">
          &ldquo;{a.reasoning}&rdquo;
        </blockquote>
      ) : null}

      <div className="mt-4 flex items-baseline justify-between gap-3">
        <span className="text-sm text-stone">{pending ? "Asking for" : a.status === "approved" ? "Topped up" : "Asked for"}</span>
        <Amount amount={a.amount} asset={asset} size="xl" />
      </div>

      {pending ? (
        <div className="mt-5 grid grid-cols-2 gap-3">
          <Button
            variant="ember"
            size="xl"
            className="h-14 w-full"
            disabled={isBusy || !onDecide}
            onClick={() => onDecide?.("denied")}
          >
            {busy === "denied" ? <Loader2 className="animate-spin" /> : <X />}
            Deny
          </Button>
          <Button
            variant="ward"
            size="xl"
            className="h-14 w-full"
            disabled={isBusy || !onDecide}
            onClick={() => onDecide?.("approved")}
          >
            {busy === "approved" ? <Loader2 className="animate-spin" /> : <Check />}
            Approve
          </Button>
        </div>
      ) : (
        <footer className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-arena-line pt-3 text-xs text-stone">
          <span>
            {a.status === "approved" ? "Approved" : "Denied"} {a.resolvedAt ? timeAgo(a.resolvedAt) : ""}
            {a.status === "denied" ? " · agent stopped, castle stands" : ""}
          </span>
          {a.topUp ? (
            <span className="flex items-center gap-1.5">
              top-up <HashscanLink tx={a.topUp} />
            </span>
          ) : null}
        </footer>
      )}
    </motion.article>
  );
}

function DecisionBadge({ status }: { status: ApprovalRequest["status"] }) {
  return status === "approved" ? (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ward/15 px-2.5 py-1 text-xs font-medium text-ward">
      <ShieldCheck className="size-3.5" aria-hidden /> Approved
    </span>
  ) : (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-ember/15 px-2.5 py-1 text-xs font-medium text-ember">
      <ShieldX className="size-3.5" aria-hidden /> Denied
    </span>
  );
}
