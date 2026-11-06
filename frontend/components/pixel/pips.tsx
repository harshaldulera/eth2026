import type { GuardianMove, SiegeStatus } from "@/lib/types";
import { MAX_TURNS } from "@/lib/types";
import { cn } from "@/lib/utils";

export type PipsProps = {
  /** Turns used (0–5). */
  used: number;
  total?: number;
  status?: SiegeStatus;
  /** Per-turn guard moves: each used pip burns in its move's stamp colour. */
  moves?: (GuardianMove | null | undefined)[];
  /** Blink the next pip (a message is in flight). */
  pending?: boolean;
  showLabel?: boolean;
  className?: string;
};

const MOVE_FILL: Record<GuardianMove, string> = {
  hold: "bg-stamp-hold",
  expose: "bg-stamp-flag",
  banish: "bg-stamp-lockdown",
  open: "bg-stamp-breach",
};

/**
 * Message pips `■■□□□`. Used pips burn in the move colour (or the outcome colour once the op ends);
 * on a lockdown the unused pips are crossed out and the label reads `2 LOST`.
 * Same props as the old SiegeCounter, plus `moves` and `pending`.
 *
 * @example <Pips used={siege.turn} status={siege.status} />
 */
export function Pips({ used, total = MAX_TURNS, status, moves, pending, showLabel = true, className }: PipsProps) {
  const ended = status === "held" || status === "broken" || status === "banished";
  const outcome = status === "held" ? "bg-safe" : status === "broken" ? "bg-money" : status === "banished" ? "bg-threat" : "bg-accent";
  const u = Math.max(0, Math.min(used, total));
  const lost = status === "banished" ? total - u : 0;
  const left = total - u;
  const label = lost > 0 ? `${lost} LOST` : ended ? `${u}/${total}` : left === 1 ? "1 LEFT" : `${left} LEFT`;
  return (
    <div className={cn("flex items-center gap-2.5", className)} aria-label={`${u} of ${total} messages used${lost ? `, ${lost} lost` : ""}`}>
      <div className="flex gap-1">
        {Array.from({ length: total }, (_, i) => {
          const isUsed = i < u;
          const isLost = !isUsed && i >= total - lost;
          const isNext = pending && i === u && !ended;
          const move = moves?.[i];
          const fill = isUsed ? (move ? MOVE_FILL[move] : ended ? outcome : "bg-accent") : "";
          return (
            <span
              key={i}
              aria-hidden
              className={cn(
                "relative block size-3 shadow-[inset_0_0_0_2px_var(--color-line)]",
                isUsed && cn(fill, "animate-pip shadow-[0_0_6px_-1px_currentColor]"),
                isNext && "animate-blink bg-accent/60",
                isLost && "bg-threat/10 shadow-[inset_0_0_0_2px_color-mix(in_oklab,var(--color-threat)_50%,transparent)]",
              )}
            >
              {isLost ? (
                <svg viewBox="0 0 12 12" className="absolute inset-0 size-full text-threat" aria-hidden>
                  <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth="2" shapeRendering="crispEdges" />
                </svg>
              ) : null}
            </span>
          );
        })}
      </div>
      {showLabel ? (
        <span className={cn("tabular font-ui text-[11px] tracking-[0.1em] uppercase", lost ? "text-threat" : "text-ink-dim")}>{label}</span>
      ) : null}
    </div>
  );
}
