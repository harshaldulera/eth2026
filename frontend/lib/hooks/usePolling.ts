"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

export type PollingState<T> = {
  /** Latest successful result for the current `key` (kept while a later poll fails). */
  data: T | undefined;
  /** Error of the most recent poll, cleared by the next success. */
  error: unknown;
  /** True until the first result (or error) for the current `key` arrives. */
  loading: boolean;
  /** Poll right now (resets the interval). Resolves when that poll finishes. */
  refresh: () => Promise<void>;
  /** Replace data locally (optimistic updates); the next poll overwrites it. */
  mutate: (fn: (prev: T | undefined) => T | undefined) => void;
};

type Inner<T> = { key: string; data: T | undefined; error: unknown; settled: boolean };

/**
 * Poll an async fetcher: runs immediately, then every `intervalMs` after each poll settles
 * (never overlapping). Pauses while the tab is hidden and polls at once when it becomes visible.
 * Changing `key` (e.g. a siege id) restarts polling and hides the previous key's data.
 *
 * @example
 * const { data, error, refresh } = usePolling(() => api.siege(id), 1000, { key: id });
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  intervalMs: number,
  opts: { enabled?: boolean; key?: string } = {},
): PollingState<T> {
  const { enabled = true, key = "" } = opts;
  const fetcherRef = useRef(fetcher);
  const tickRef = useRef<(() => Promise<void>) | null>(null);
  const [state, setState] = useState<Inner<T>>({ key, data: undefined, error: undefined, settled: false });

  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (!enabled) {
      tickRef.current = null;
      return;
    }
    let cancelled = false;
    let inFlight: Promise<void> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const schedule = () => {
      clearTimeout(timer);
      if (!cancelled) timer = setTimeout(() => void tick(), intervalMs);
    };

    const tick = (): Promise<void> => {
      if (cancelled) return Promise.resolve();
      if (inFlight) return inFlight;
      clearTimeout(timer);
      if (typeof document !== "undefined" && document.visibilityState === "hidden") {
        schedule();
        return Promise.resolve();
      }
      inFlight = (async () => {
        try {
          const data = await fetcherRef.current();
          if (!cancelled) setState({ key, data, error: undefined, settled: true });
        } catch (error) {
          if (!cancelled) setState((s) => ({ key, data: s.key === key ? s.data : undefined, error, settled: true }));
        } finally {
          inFlight = null;
          schedule();
        }
      })();
      return inFlight;
    };

    const onVisible = () => {
      if (document.visibilityState === "visible") void tick();
    };

    tickRef.current = tick;
    void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      tickRef.current = null;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, intervalMs, key]);

  const refresh = useCallback(() => tickRef.current?.() ?? Promise.resolve(), []);
  const mutate = useCallback(
    (fn: (prev: T | undefined) => T | undefined) =>
      setState((s) => (s.key === key ? { ...s, data: fn(s.data) } : s)),
    [key],
  );

  const current = state.key === key;
  return {
    data: current ? state.data : undefined,
    error: current ? state.error : undefined,
    loading: enabled && (!current || !state.settled),
    refresh,
    mutate,
  };
}

type Clock = { now: number; subs: Set<() => void>; timer?: ReturnType<typeof setInterval>; subscribe: (cb: () => void) => () => void; get: () => number };
const clocks = new Map<number, Clock>();

function clock(ms: number): Clock {
  let c = clocks.get(ms);
  if (c) return c;
  const self: Clock = {
    now: 0,
    subs: new Set(),
    subscribe(cb) {
      self.subs.add(cb);
      if (!self.timer) {
        self.now = Date.now();
        self.timer = setInterval(() => {
          self.now = Date.now();
          self.subs.forEach((f) => f());
        }, ms);
      }
      return () => {
        self.subs.delete(cb);
        if (self.subs.size === 0 && self.timer) {
          clearInterval(self.timer);
          self.timer = undefined;
        }
      };
    },
    // Only called in the browser (the server snapshot is 0), so reading the clock here never
    // happens during a prerender.
    get() {
      if (!self.now) self.now = Date.now();
      return self.now;
    },
  };
  c = self;
  clocks.set(ms, c);
  return c;
}

const noSubscribe = () => () => {};

/**
 * Shared ticking clock: returns Date.now(), refreshed every `ms` (for "waiting 0:12" timers).
 * Returns 0 during server render/prerender; treat 0 as "unknown".
 */
export function useNow(ms = 1000, enabled = true): number {
  const c = clock(ms);
  return useSyncExternalStore(enabled ? c.subscribe : noSubscribe, c.get, () => 0);
}
