"use client";

import { useEffect, useRef, useState } from "react";
import type { StoredSiegeEvent } from "@/lib/types";
import { api } from "@/lib/api/client";

type Feed = { key: string; events: StoredSiegeEvent[]; cursor: number; error: unknown; ready: boolean };

/**
 * Incremental event feed over GET /api/events (cursor-based, no duplicates). Keeps the newest
 * `limit` events in ascending id order. Pauses while the tab is hidden.
 * `tail: true` starts from the newest `limit` events (a live ticker) instead of replaying the whole
 * history from event 1.
 *
 * @example const { events } = useEventFeed({ siegeId: id, intervalMs: 1000 });
 */
export function useEventFeed(opts: { siegeId?: string; intervalMs?: number; limit?: number; enabled?: boolean; tail?: boolean } = {}) {
  const { siegeId, intervalMs = 2000, limit = 200, enabled = true, tail = false } = opts;
  const key = siegeId ?? "*";
  const [feed, setFeed] = useState<Feed>({ key, events: [], cursor: 0, error: undefined, ready: false });
  const cursorRef = useRef<{ key: string; cursor: number }>({ key, cursor: 0 });

  useEffect(() => {
    if (!enabled) return;
    if (cursorRef.current.key !== key) cursorRef.current = { key, cursor: 0 };
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;

    const tick = async () => {
      if (cancelled || busy) return;
      clearTimeout(timer);
      if (document.visibilityState === "hidden") {
        timer = setTimeout(tick, intervalMs);
        return;
      }
      busy = true;
      try {
        const first = cursorRef.current.cursor === 0;
        const res = await api.events(first && tail ? { tail: limit, siegeId } : { cursor: cursorRef.current.cursor, siegeId });
        if (cancelled) return;
        cursorRef.current = { key, cursor: Math.max(cursorRef.current.cursor, res.cursor ?? 0) };
        setFeed((f) => {
          const base = f.key === key ? f.events : [];
          const seen = new Set(base.map((e) => e.id));
          const fresh = (res.events ?? []).filter((e) => !seen.has(e.id));
          const events = fresh.length ? [...base, ...fresh].sort((a, b) => a.id - b.id).slice(-limit) : base;
          return { key, events, cursor: cursorRef.current.cursor, error: undefined, ready: true };
        });
      } catch (error) {
        if (!cancelled) setFeed((f) => ({ ...(f.key === key ? f : { key, events: [], cursor: 0 }), error, ready: true }));
      } finally {
        busy = false;
        if (!cancelled) timer = setTimeout(tick, intervalMs);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };
    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, intervalMs, key, siegeId, limit, tail]);

  const current = feed.key === key;
  return {
    events: current ? feed.events : [],
    error: current ? feed.error : undefined,
    ready: current && feed.ready,
  };
}
