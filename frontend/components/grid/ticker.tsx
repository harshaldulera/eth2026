"use client";

import { useMemo } from "react";
import { useEventFeed } from "@/lib/hooks/useEventFeed";
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
 * stands still under reduced motion). Sticks to the bottom of the viewport.
 *
 * @example <GridTicker names={namesById} />
 */
export function GridTicker({ names, className }: { names: ReadonlyMap<string, string>; className?: string }) {
  const { events, ready, error } = useEventFeed({ intervalMs: 2500, limit: 60, tail: true });
  const now = useNow(10_000);
  const shown = useMemo(() => [...events].reverse().filter(tickerWorthy).slice(0, 12), [events]);
  const name = (id: string | undefined) => (id ? names.get(id) : undefined);
  const lines = shown.map((e) => <EventLine key={e.id} event={e} castleName={name} now={now} variant="ticker" />);

  return (
    <div className={cn("sticky bottom-0 z-30 flex items-stretch bg-bg", className)}>
      <span className="flex shrink-0 items-center gap-1.5 border-y-2 border-r-2 border-line bg-raised px-2.5 font-ui text-[10px] tracking-[0.14em] text-threat">
        <span className="size-2 animate-blink bg-threat shadow-[0_0_6px_currentColor]" aria-hidden />
        <span className="max-sm:sr-only">FEED</span>
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
