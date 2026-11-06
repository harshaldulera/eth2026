"use client";

import { useMemo } from "react";
import { useLiveEvents, type LiveEvents } from "@/lib/hooks/useLiveEvents";
import { useNow } from "@/lib/hooks/usePolling";
import type { StoredSiegeEvent } from "@/lib/types";
import { Marquee } from "@/components/pixel/marquee";
import { EventLine } from "@/components/arena/event-line";
import { cn } from "@/lib/utils";

/** Events worth a ticker line: starts, ends, money, approvals, flags/breaches, vault states. */
function tickerWorthy(e: StoredSiegeEvent): boolean {
  if (e.type === "message") return false;
  if (e.type === "decision") return ["open", "expose"].includes(String(e.payload?.move));
  if (e.type === "vault_state") return ["guarding", "dormant", "closed"].includes(String(e.payload?.to));
  return true;
}

/**
 * The Grid's bottom LED ticker: the newest events scrolling right-to-left (pauses on hover/focus;
 * stands still under reduced motion). Sticks to the bottom of the viewport. Events stream over SSE
 * (GET /api/events/stream, polling fallback): pass the page's `feed` to share one connection, or
 * the ticker opens its own.
 *
 * @example <GridTicker names={namesById} feed={useLiveEvents({ tail: 60, limit: 60 })} />
 */
export function GridTicker({ names, feed, className }: { names: ReadonlyMap<string, string>; feed?: LiveEvents; className?: string }) {
  const own = useLiveEvents({ tail: 60, limit: 60, enabled: !feed });
  const { events, ready, error, mode } = feed ?? own;
  const now = useNow(10_000);
  const shown = useMemo(() => [...events].reverse().filter(tickerWorthy).slice(0, 12), [events]);
  const name = (id: string | undefined) => (id ? names.get(id) : undefined);
  const lines = shown.map((e) => <EventLine key={e.id} event={e} castleName={name} now={now} variant="ticker" />);

  return (
    <div className={cn("sticky bottom-0 z-30 flex items-stretch bg-bg", className)}>
      <span
        className={cn(
          "flex shrink-0 items-center gap-1.5 border-y-2 border-r-2 border-line bg-raised px-2.5 font-ui text-[10px] tracking-[0.14em]",
          mode === "live" ? "text-threat" : mode === "polling" ? "text-warn" : "text-ink-dim",
        )}
        title={mode === "live" ? "Streaming events as they happen" : mode === "polling" ? "Stream unavailable, checking every few seconds" : "Connecting to the event stream"}
      >
        <span className={cn("size-2 shadow-[0_0_6px_currentColor]", mode === "live" ? "animate-blink bg-threat" : mode === "polling" ? "bg-warn" : "bg-ink-dim")} aria-hidden />
        <span className="max-sm:sr-only">{mode === "polling" ? "FEED · POLLING" : "FEED"}</span>
      </span>
      {!ready || lines.length === 0 ? (
        <p className="flex min-w-0 flex-1 items-center border-y-2 border-line bg-bg/80 px-3 py-1.5 font-term text-lg text-ink-dim" role="status">
          {!ready ? "> tuning in…" : error ? "> feed offline · retrying" : "> quiet on the Grid · run an op to start the feed"}
        </p>
      ) : (
        <Marquee label="Recent events" duration={Math.max(24, lines.length * 7)} className="min-w-0 flex-1">
          {lines}
        </Marquee>
      )}
    </div>
  );
}
