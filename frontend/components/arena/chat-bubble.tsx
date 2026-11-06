"use client";

import { Caret } from "@/components/pixel/terminal";
import type { SiegeMessage } from "@/lib/types";
import { cn } from "@/lib/utils";
import { MoveBadge } from "./move-badge";

/**
 * Transcript lines in the console style (the op room itself now renders `OpConsole`; these stay
 * for lists and previews). Operator = accent rule, guard = line rule with its move and 0G id.
 *
 * @example <RaiderBubble text={m.text} turn={m.turn} />
 * @example <GuardianBubble message={m} exposed="authority claim" fresh />
 */
export function RaiderBubble({ text, turn, pending, tactic }: { text: string; turn: number; pending?: boolean; tactic?: string }) {
  return (
    <div className="space-y-1">
      <p className="font-term text-[19px] leading-none text-accent">
        &gt; OPERATOR · MSG {turn}
        {tactic ? <span className="text-warn"> · {tactic}</span> : null}
        {pending ? <span className="ml-2 animate-blink text-warn">SENDING</span> : null}
      </p>
      <p className={cn("border-l-2 border-accent/40 pl-3 text-[15px] leading-relaxed break-words whitespace-pre-wrap text-ink", pending && "opacity-80")}>{text}</p>
    </div>
  );
}

export function GuardianBubble({
  message: m,
  guardianName,
  exposed,
  fresh,
}: {
  message: SiegeMessage;
  guardianName?: string;
  exposed?: string;
  /** Just landed: the request id glows in. */
  fresh?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-term text-[19px] leading-none text-ink">&lt; GUARD · {(guardianName ?? "Guard").toUpperCase()}</p>
        {m.requestId ? (
          <span className={cn("font-mono text-[11px]", fresh ? "text-money" : "text-ink-dim")} title="0G request id of this reply (recorded by the arena's model proxy)">
            0G {m.requestId}
          </span>
        ) : null}
      </div>
      <p className="border-l-2 border-line pl-3 text-[15px] leading-relaxed break-words whitespace-pre-wrap text-ink/90">{m.text}</p>
      {m.move ? (
        <div className="pl-3">
          <MoveBadge move={m.move} exposed={exposed} />
        </div>
      ) : null}
    </div>
  );
}

export function ThinkingBubble({ guardianName }: { guardianName?: string }) {
  return (
    <p className="font-term text-[19px] text-warn" role="status" aria-live="polite">
      &lt; {(guardianName ?? "Guard").toUpperCase()} · THINKING ON 0G
      <Caret />
    </p>
  );
}
