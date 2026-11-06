"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ApprovalRequest, Asset } from "@/lib/types";
import { HBAR, assetSymbol, timeAgo, toNumber } from "@/lib/money/format";
import { useCalmMotion } from "@/lib/hooks/usePrefs";
import { BUTTONS, threatWord, UNITS } from "@/lib/vocab";
import { cn } from "@/lib/utils";
import { PixelButton } from "@/components/pixel/button";
import { Digits } from "@/components/pixel/digits";
import { LED } from "@/components/pixel/led";
import { Meter } from "@/components/pixel/meter";
import { Stamp } from "@/components/pixel/stamp";
import { HashscanLink } from "./hashscan-link";

/** Why an agent paused, in plain words. */
export function reasonText(a: Pick<ApprovalRequest, "reason" | "castleName">): string {
  switch (a.reason) {
    case "per_castle":
      return `Hit its per-vault cap on ${a.castleName}`;
    case "daily":
      return "Hit its daily spending cap";
    case "budget":
      return "Ran out of budget";
    case "stop_rule":
      return "Lost too many ops in a row — its stop rule kicked in";
    case "stopped":
      return "Was stopped and wants to resume";
    case "zg_key":
      return "Its 0G key was rejected — check your credits at pc.0g.ai";
    default:
      return "Needs your go-ahead";
  }
}

/** The radio-call line: `per-vault cap hit on SALTMARSH KEEP`. */
export function capLine(a: Pick<ApprovalRequest, "reason" | "castleName">): string {
  switch (a.reason) {
    case "per_castle":
      return `per-vault cap hit on ${a.castleName.toUpperCase()}`;
    case "daily":
      return "daily cap hit";
    case "budget":
      return "budget spent";
    case "stop_rule":
      return "stop rule: too many ops lost in a row";
    case "stopped":
      return "stopped · asks to resume";
    default:
      return "needs your go-ahead";
  }
}

/**
 * Does approving this ask move HBAR? Arena units: an on-chain top-up. A unit its red teamer funded: only
 * a `budget` ask does (through a top-up deposit); a cap ask just raises the cap. Same rule as the mission log.
 */
export function approveMovesMoney(a: Pick<ApprovalRequest, "topUp" | "reason" | "deposit" | "fundedBy">): boolean {
  return Boolean(a.topUp || a.deposit || a.reason === "budget" || a.fundedBy !== "operator");
}

/** `2.00 ℏ`: request amounts always show two decimals so they read like a price. */
export function askText(amount: ApprovalRequest["amount"], asset: Asset = HBAR): { num: string; unit: string } {
  return { num: toNumber(amount, asset).toFixed(2), unit: assetSymbol(asset) };
}

export type ApprovalCardProps = {
  approval: ApprovalRequest;
  onDecide?: (decision: "approved" | "denied") => void;
  /** true while a decision is in flight; or the decision being sent (spinner on that button). */
  busy?: boolean | "approved" | "denied";
  asset?: Asset;
  /** One-line history row instead of the full sheet (decided cards further down the pager). */
  compact?: boolean;
  className?: string;
};

/**
 * The owner's decision card, drawn as a pager sheet. Pending: vault name big, why, the threat the
 * agent reached, its reasoning on an LCD strip, `ASKING FOR 2.00 ℏ` and two 56 px thumb keys
 * (DENY left in the attack colour, APPROVE right in the hold colour). When it is decided while on
 * screen the sheet flips (300 ms) to a stamped result with the top-up link.
 *
 * @example <ApprovalCard approval={a} onDecide={(d) => decide(a.id, d)} busy={sending} />
 */
export function ApprovalCard({ approval: a, onDecide, busy, asset = HBAR, compact, className }: ApprovalCardProps) {
  const calm = useCalmMotion();
  const pending = a.status === "pending";
  // A card that was pending when it mounted slams its stamp when decided; history cards don't.
  const [seenPending, setSeenPending] = useState(pending);
  if (pending && !seenPending) setSeenPending(true);
  const fresh = !pending && seenPending;

  if (compact && !pending) return <DecidedRow a={a} asset={asset} className={className} />;

  const flip = calm
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.12 } }
    : {
        initial: { rotateX: 90, opacity: 0.4 },
        animate: { rotateX: 0, opacity: 1 },
        exit: { rotateX: -90, opacity: 0.4 },
        transition: { duration: 0.15, ease: "easeIn" as const },
      };

  return (
    <article
      className={cn("[perspective:900px]", className)}
      aria-label={`Approval request from ${a.agentName} for ${a.castleName}`}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={pending ? "pending" : "decided"}
          {...flip}
          style={{ transformOrigin: "50% 50%" }}
          className={cn(
            "relative bg-panel p-4 px-frame sm:p-5",
            pending
              ? "[--frame:color-mix(in_oklab,var(--color-money)_60%,var(--color-line))]"
              : a.status === "approved"
                ? "[--frame:color-mix(in_oklab,var(--color-safe)_50%,var(--color-line))]"
                : "[--frame:color-mix(in_oklab,var(--color-threat)_50%,var(--color-line))]",
          )}
        >
          <header className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate font-ui text-[11px] tracking-[0.12em] text-ink-dim uppercase">
              {a.agentName} · {timeAgo(a.createdAt)}
            </p>
            {pending ? <LED kind="warn" label="WAITING" /> : null}
          </header>
          <h3 className="mt-2 font-ui text-2xl leading-tight break-words text-ink uppercase">{a.castleName}</h3>
          <p className="mt-1 text-[15px] leading-snug text-ink/85">{reasonText(a)}</p>

          {pending ? <PendingFace a={a} asset={asset} busy={busy} onDecide={onDecide} /> : <DecidedFace a={a} asset={asset} slam={fresh} />}
        </motion.div>
      </AnimatePresence>
    </article>
  );
}

function PendingFace({ a, asset, busy, onDecide }: { a: ApprovalRequest; asset: Asset; busy: ApprovalCardProps["busy"]; onDecide: ApprovalCardProps["onDecide"] }) {
  const isBusy = Boolean(busy);
  const ask = askText(a.amount, asset);
  return (
    <>
      <div className="mt-4">
        <Meter
          value={a.pressure}
          size="lg"
          label="Threat reached"
          showLabel
          valueText={
            <span>
              {a.pressure} <span className="text-ink-dim">{threatWord(a.pressure)}</span>
            </span>
          }
        />
      </div>

      {a.reasoning ? (
        <div className="mt-4 border-2 border-line bg-[color-mix(in_oklab,var(--color-accent)_8%,var(--color-bg))] px-3 py-2 shadow-[inset_0_0_14px_rgb(0_0_0/0.55)]">
          <p className="font-term text-[20px] leading-[1.15] text-accent">
            <span aria-hidden className="text-ink-dim">
              &gt;{" "}
            </span>
            {a.reasoning}
          </p>
        </div>
      ) : null}

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-ui text-xs tracking-[0.12em] text-ink-dim uppercase">Asking for</span>
        <span>
          <span className="sr-only">
            {ask.num} {ask.unit}
          </span>
          <span aria-hidden>
            <Digits value={ask.num} unit={ask.unit} size="lg" tone="money" />
          </span>
        </span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <PixelButton
          variant="threat"
          size="xl"
          cue="deny"
          className="w-full"
          disabled={isBusy || !onDecide}
          onClick={() => onDecide?.("denied")}
        >
          {busy === "denied" ? <Loader2 className="animate-spin" /> : null}
          {BUTTONS.deny}
        </PixelButton>
        <PixelButton
          variant="safe"
          size="xl"
          cue="approve"
          className="w-full"
          disabled={isBusy || !onDecide}
          onClick={() => onDecide?.("approved")}
        >
          {busy === "approved" ? <Loader2 className="animate-spin" /> : null}
          {BUTTONS.approve}
        </PixelButton>
      </div>
    </>
  );
}

function DecidedFace({ a, asset, slam }: { a: ApprovalRequest; asset: Asset; slam: boolean }) {
  const approved = a.status === "approved";
  const ask = askText(a.amount, asset);
  const money = approveMovesMoney(a);
  return (
    <div className="mt-4 flex flex-col items-start gap-3">
      <Stamp kind={approved ? "hold" : "lockdown"} size="lg" slam={slam}>
        {approved ? "APPROVED" : "DENIED"}
      </Stamp>
      <p className="font-ui text-sm tracking-[0.06em] text-ink uppercase">
        {approved ? (
          <>
            <span className="text-money">
              +{ask.num} {ask.unit}
            </span>{" "}
            {money ? UNITS.decidedTopUp : UNITS.decidedCapRaised}
          </>
        ) : (
          <>agent stopped · vault stands</>
        )}
      </p>
      <div className="flex w-full flex-wrap items-center justify-between gap-2 border-t-2 border-dashed border-line pt-2.5 text-xs text-ink-dim">
        <span>
          {approved ? "approved" : "denied"} {a.resolvedAt ? timeAgo(a.resolvedAt) : ""}
        </span>
        {a.topUp ? (
          <HashscanLink tx={a.topUp} label={`top-up ${ask.num} ${ask.unit}`} />
        ) : approved ? (
          <span>{money ? UNITS.settling : UNITS.noHbarMoved}</span>
        ) : null}
      </div>
    </div>
  );
}

function DecidedRow({ a, asset, className }: { a: ApprovalRequest; asset: Asset; className?: string }) {
  const approved = a.status === "approved";
  const ask = askText(a.amount, asset);
  return (
    <article
      className={cn("flex items-center gap-3 bg-panel px-3 py-2.5 px-frame", className)}
      aria-label={`${approved ? "Approved" : "Denied"}: ${a.agentName} on ${a.castleName}`}
    >
      <span className={cn("w-[84px] shrink-0 font-ui text-xs tracking-[0.1em]", approved ? "text-safe" : "text-threat")}>{approved ? "APPROVED" : "DENIED"}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-ui text-xs text-ink uppercase">{a.castleName}</span>
        <span className="block truncate text-xs text-ink-dim">
          {a.agentName} · {a.resolvedAt ? timeAgo(a.resolvedAt) : timeAgo(a.createdAt)}
        </span>
      </span>
      {approved && a.topUp ? (
        <HashscanLink tx={a.topUp} label={`+${ask.num} ${ask.unit}`} />
      ) : (
        <span className="tabular shrink-0 font-mono text-xs text-ink-dim">
          {ask.num} {ask.unit}
        </span>
      )}
    </article>
  );
}
