"use client";

import type { ApprovalRequest, Asset } from "@/lib/types";
import { HBAR } from "@/lib/money/format";
import { useNow } from "@/lib/hooks/usePolling";
import { cn } from "@/lib/utils";
import { Digits } from "@/components/pixel/digits";
import { LED } from "@/components/pixel/led";
import { Sprite } from "@/components/pixel/sprite";
import { askText, capLine } from "./approval-card";

export type WaitingForOwnerProps = {
  approval: ApprovalRequest;
  /** When the wait began (ISO or unix ms); defaults to approval.createdAt. */
  since?: string | number;
  asset?: Asset;
  /** Ops the agent ran on this vault (adds `· 2 ops` to the reason line). */
  ops?: number;
  className?: string;
};

/** `00:12`, `03:05`, `61:00`. */
export function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

// Signal bars light one after another (steps, no tweening); reduced motion keeps them all lit.
const BARS_CSS = `@keyframes p4-signal{0%,24%{opacity:.18}25%,100%{opacity:1}}
.p4-bar{animation:p4-signal 1.2s steps(1,end) infinite}
.p4-bar:nth-child(2){animation-delay:.3s}.p4-bar:nth-child(3){animation-delay:.6s}
@media (prefers-reduced-motion:reduce){.p4-bar{animation:none}}
html[data-calm="1"] .p4-bar{animation:none}`;

/** Three rising signal bars next to the radio. */
export function SignalBars({ className }: { className?: string }) {
  return (
    <>
      <style href="p4-signal" precedence="medium">
        {BARS_CSS}
      </style>
      <span aria-hidden className={cn("inline-flex items-end gap-[3px]", className)}>
        {[8, 14, 20].map((h) => (
          <span key={h} className="p4-bar w-[5px] bg-warn shadow-[0_0_6px_-1px_currentColor] text-warn" style={{ height: h }} />
        ))}
      </span>
    </>
  );
}

/**
 * COMMS: the agent hit a cap and is on the radio to its owner. Radio sprite with signal bars,
 * `NIGHT SAPPER → OWNER`, the reason, `REQUESTING +2.00 ℏ` and a live `WAITING 00:12` clock.
 * Presentational: the console decides when to play the `radio_call` cue.
 *
 * @example <WaitingForOwner approval={pendingApproval} ops={2} />
 */
export function WaitingForOwner({ approval, since, asset = HBAR, ops, className }: WaitingForOwnerProps) {
  const now = useNow(1000);
  const start = typeof since === "number" ? since : Date.parse(since ?? approval.createdAt);
  const elapsed = Number.isFinite(start) && now > 0 ? (now - start) / 1000 : 0;
  const ask = askText(approval.amount, asset);
  const reason = [capLine(approval), ops ? `${ops} ${ops === 1 ? "op" : "ops"}` : null, `best threat ${approval.pressure}`]
    .filter(Boolean)
    .join(" · ");

  return (
    <section
      className={cn("relative bg-panel px-frame [--frame:color-mix(in_oklab,var(--color-warn)_65%,var(--color-line))]", className)}
      aria-label={`${approval.agentName} is waiting for the owner`}
    >
      <div className="flex min-h-9 items-center justify-between gap-3 border-b-2 border-line bg-[color-mix(in_oklab,var(--color-warn)_12%,var(--color-raised))] px-3 py-1.5">
        <h2 className="flex items-center gap-2 font-ui text-xs tracking-[0.16em] text-warn uppercase">
          <span className="size-2 shrink-0 bg-warn" aria-hidden />
          Comms
        </h2>
        <LED kind="warn" label="ON AIR" />
      </div>

      <div className="flex gap-4 p-4">
        <div className="flex shrink-0 flex-col items-center gap-2 pt-1">
          <div className="flex items-end gap-1.5">
            <Sprite name="radio" animate scale={3} />
            <SignalBars />
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <p className="font-ui text-base leading-tight tracking-[0.06em] text-ink uppercase sm:text-lg">
            {approval.agentName} <span className="text-warn">→</span> Owner
          </p>
          <p className="mt-1 font-term text-[20px] leading-[1.1] text-warn">{reason}</p>
          {approval.reasoning ? <p className="mt-2 text-sm leading-snug text-ink/85 italic">&ldquo;{approval.reasoning}&rdquo;</p> : null}

          <div className="mt-3 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
            <div>
              <p className="font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">Requesting</p>
              <span className="sr-only">
                +{ask.num} {ask.unit}
              </span>
              <span aria-hidden>
                <Digits value={`+${ask.num}`} unit={ask.unit} size="md" tone="money" />
              </span>
            </div>
            <div className="text-right">
              <p className="font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">Waiting</p>
              <Digits value={mmss(elapsed)} size="md" tone="warn" />
            </div>
          </div>
          <p className="mt-3 text-xs text-ink-dim">Only the owner can let it keep spending. The pager has the request.</p>
        </div>
      </div>
    </section>
  );
}
