"use client";

import { CLASS_META } from "@/lib/scene/classes";
import { threatWord } from "@/lib/vocab";
import { Sprite } from "@/components/pixel/sprite";
import { cn } from "@/lib/utils";
import type { ReplayData } from "@/lib/replay/types";
import type { TurnSummary } from "./turns";
import { TurnEvidence, providerOf } from "./verify-checks";

const RING = { hold: "[--frame:var(--color-stamp-hold)]", flag: "[--frame:var(--color-stamp-flag)]", lockdown: "[--frame:var(--color-stamp-lockdown)]", breach: "[--frame:var(--color-stamp-breach)]" } as const;

const STAMP_CHIP = { hold: "border-stamp-hold text-stamp-hold", flag: "border-stamp-flag text-stamp-flag", lockdown: "border-stamp-lockdown text-stamp-lockdown", breach: "border-stamp-breach text-stamp-breach" } as const;

const shortReq = (id?: string) => (id ? (id.length > 14 ? `${id.slice(0, 12)}…` : id) : "");

/**
 * One chip per message: class icon · class name · the referee's exact label · the verdict stamp ·
 * model request id · threat, and under it the recomputed evidence (lib/replay): the message hash
 * against the HCS audit log, the reply's tool calls and inference record. The chip under the
 * playhead is lit; clicking a chip jumps to its message.
 */
export function StepChips({
  turns,
  currentTurn,
  onPick,
  verify,
  protectedTool,
  className,
}: {
  turns: TurnSummary[];
  currentTurn: number;
  onPick: (t: TurnSummary) => void;
  verify?: ReplayData | null;
  protectedTool: string;
  className?: string;
}) {
  if (!turns.length) {
    return <p className={cn("font-term text-lg text-ink-dim", className)}>&gt; no messages on this tape yet</p>;
  }
  return (
    <ol className={cn("flex flex-col gap-2", className)} aria-label="Messages">
      {turns.map((t) => {
        const meta = CLASS_META[t.cls];
        const active = t.turn === currentTurn;
        const ev = verify?.turns.find((v) => v.turn === t.turn);
        return (
          <li key={t.turn}>
            <button
              type="button"
              onClick={() => onPick(t)}
              aria-current={active ? "step" : undefined}
              className={cn(
                "group grid w-full grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 bg-panel p-2.5 text-left px-frame transition-[filter] hover:brightness-125 focus-visible:outline-2 focus-visible:outline-accent",
                active && "bg-raised",
                active && t.stamp && RING[t.stamp.kind],
              )}
            >
              <span className="row-span-2 flex flex-col items-center gap-1 pt-0.5">
                <span className={cn("font-ui text-[10px] leading-none", active ? "text-accent glow" : "text-ink-dim")}>{String(t.turn).padStart(2, "0")}</span>
                <Sprite name={meta.icon} scale={2} label={meta.label} />
              </span>
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="font-ui text-[11px] tracking-[0.06em] text-ink">{meta.label}</span>
                <span className="truncate font-term text-base leading-none text-ink-dim">{t.label ?? "probing"}{t.clsSource === "client" ? " · client" : ""}</span>
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                {t.stamp ? (
                  <span className={cn("border-2 px-1.5 py-0.5 font-ui text-[12px] leading-none tracking-[0.08em]", STAMP_CHIP[t.stamp.kind])} title={t.stamp.text}>
                    {t.stamp.word}
                    {t.stamp.referee ? " (referee)" : ""}
                  </span>
                ) : (
                  <span className="font-ui text-[11px] text-ink-dim">PENDING…</span>
                )}
                <span className="font-term text-base leading-none text-ink-dim tabular-nums">
                  threat <span className={cn(t.threat >= 70 ? "text-threat" : t.threat >= 40 ? "text-warn" : "text-ink")}>{t.threat}</span> {threatWord(t.threat)}
                </span>
                {t.requestId ? (
                  <span className="truncate font-mono text-[11px] text-ink-dim">
                    {providerOf(ev)} req {shortReq(t.requestId)}
                  </span>
                ) : null}
              </span>
              {ev ? (
                <span className="col-start-2 min-w-0 border-t-2 border-line/50 pt-1.5">
                  <TurnEvidence t={ev} protectedTool={protectedTool} />
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
    </ol>
  );
}
