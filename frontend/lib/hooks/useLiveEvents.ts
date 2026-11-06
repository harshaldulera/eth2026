"use client";

import { useEffect, useRef, useState } from "react";
import type { StoredSiegeEvent } from "@/lib/types";
import { api } from "@/lib/api/client";

export type LiveEventsOptions = {
  siegeId?: string;
  castleId?: string;
  /** Start from the newest N events instead of the whole history (a ticker). */
  tail?: number;
  /** Keep at most this many events, newest last. */
  limit?: number;
  enabled?: boolean;
  /** Called once per new event, in order (after dedup). */
  onEvent?: (e: StoredSiegeEvent) => void;
};

export type LiveEvents = {
  events: StoredSiegeEvent[];
  /** "live": streaming over SSE; "polling": the stream failed, reading /api/events instead. */
  mode: "connecting" | "live" | "polling";
  error: unknown;
  ready: boolean;
};

/** After this many failed reconnects in a row, fall back to polling. */
const MAX_STREAM_FAILURES = 3;
const POLL_MS = 1500;
/** While polling, try the stream again this often. */
const RETRY_STREAM_MS = 30_000;

type State = { key: string; events: StoredSiegeEvent[]; mode: LiveEvents["mode"]; error: unknown; ready: boolean };

/**
 * Live event feed over Server-Sent Events (GET /api/events/stream), with resume and a polling
 * fallback. Events arrive in id order with no duplicates, across reconnects, mode switches and
 * effect re-runs. While the tab is hidden the connection is closed (a browser allows only six per
 * host over HTTP/1.1); it resumes from the last event when the tab is shown again.
 *
 * @example const { events, mode } = useLiveEvents({ siegeId: id, onEvent: (e) => e.type === "end" && refresh() });
 */
export function useLiveEvents(opts: LiveEventsOptions = {}): LiveEvents {
  const { siegeId, castleId, tail, limit = 200, enabled = true } = opts;
  const key = `${siegeId ?? ""}|${castleId ?? ""}|${tail ?? ""}`;
  const [state, setState] = useState<State>({ key, events: [], mode: "connecting", error: undefined, ready: false });
  const onEventRef = useRef(opts.onEvent);
  useEffect(() => {
    onEventRef.current = opts.onEvent;
  });
  // What this key has already delivered survives effect re-runs (enabled/limit changes, StrictMode).
  const heldRef = useRef<{ key: string; ids: Set<number>; cursor: number }>({ key, ids: new Set(), cursor: 0 });

  useEffect(() => {
    if (!enabled) return;
    if (heldRef.current.key !== key) heldRef.current = { key, ids: new Set(), cursor: 0 };
    const held = heldRef.current;
    let cancelled = false;
    let es: EventSource | null = null;
    let failures = 0;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // Bumped whenever polling stops, so a fetch still in flight cannot restart its loop.
    let pollGen = 0;

    const accept = (batch: StoredSiegeEvent[]) => {
      if (cancelled) return;
      const fresh = batch.filter((e) => !held.ids.has(e.id)).sort((a, b) => a.id - b.id);
      if (!fresh.length) return;
      for (const e of fresh) {
        held.ids.add(e.id);
        held.cursor = Math.max(held.cursor, e.id);
      }
      setState((s) => {
        const base = s.key === key ? s.events : [];
        return { ...s, key, events: [...base, ...fresh].slice(-limit), error: undefined, ready: true };
      });
      for (const e of fresh) onEventRef.current?.(e);
    };
    const setMode = (mode: LiveEvents["mode"], extra: Partial<State> = {}) =>
      setState((s) => ({ ...(s.key === key ? s : { key, events: [], error: undefined, ready: false }), mode, ...extra }));

    const query = () => {
      const p = new URLSearchParams();
      if (siegeId) p.set("siegeId", siegeId);
      if (castleId) p.set("castleId", castleId);
      if (held.cursor) p.set("cursor", String(held.cursor));
      else if (tail) p.set("tail", String(tail));
      return p.toString();
    };

    const closeStream = () => {
      es?.close();
      es = null;
    };

    const fallBackToPolling = () => {
      closeStream();
      setMode("polling", { ready: true });
      startPolling();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        stopPolling();
        failures = 0;
        setMode("connecting");
        openStream();
      }, RETRY_STREAM_MS);
    };

    const openStream = () => {
      if (cancelled || document.visibilityState === "hidden") return;
      closeStream();
      const source = new EventSource(`/api/events/stream?${query()}`);
      es = source;
      source.onopen = () => {
        failures = 0;
        setMode("live", { ready: true });
      };
      // Named events (`event: start`, …) do not reach onmessage; listen to every type we emit.
      const onData = (m: MessageEvent<string>) => {
        try {
          accept([JSON.parse(m.data) as StoredSiegeEvent]);
        } catch {
          /* a malformed frame is skipped, the next one carries on */
        }
      };
      for (const t of ["start", "message", "decision", "end", "attempt", "release", "approval", "vault_state"]) source.addEventListener(t, onData as EventListener);
      source.onmessage = onData;
      source.onerror = () => {
        if (cancelled || es !== source) return;
        // An HTTP error or a wrong content type closes the EventSource for good: the browser will
        // not reconnect, so fall back now. Otherwise it reconnects by itself (with Last-Event-ID).
        if (source.readyState === EventSource.CLOSED) return fallBackToPolling();
        failures += 1;
        if (failures >= MAX_STREAM_FAILURES) fallBackToPolling();
      };
    };

    const poll = async (gen: number) => {
      if (cancelled || gen !== pollGen) return;
      try {
        const first = held.cursor === 0 && tail;
        const res = await api.events(first ? { tail, siegeId, castleId } : { cursor: held.cursor, siegeId, castleId });
        if (cancelled || gen !== pollGen) return;
        accept(res.events);
        if (res.cursor) held.cursor = Math.max(held.cursor, res.cursor);
        setState((s) => (s.key === key && !s.ready ? { ...s, ready: true } : s));
      } catch (error) {
        if (!cancelled && gen === pollGen) setState((s) => (s.key === key ? { ...s, error, ready: true } : s));
      } finally {
        if (!cancelled && gen === pollGen) pollTimer = setTimeout(() => void poll(gen), POLL_MS);
      }
    };
    const startPolling = () => {
      pollGen += 1;
      clearTimeout(pollTimer);
      void poll(pollGen);
    };
    const stopPolling = () => {
      pollGen += 1;
      clearTimeout(pollTimer);
    };

    const resume = () => {
      if (typeof EventSource === "undefined") {
        setMode("polling");
        startPolling();
      } else openStream();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        closeStream();
        stopPolling();
        clearTimeout(retryTimer);
      } else if (!es) {
        failures = 0;
        resume();
      }
    };

    resume();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      closeStream();
      stopPolling();
      clearTimeout(retryTimer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, key, siegeId, castleId, tail, limit]);

  const current = state.key === key;
  return {
    events: current ? state.events : [],
    mode: current ? state.mode : "connecting",
    error: current ? state.error : undefined,
    ready: current && state.ready,
  };
}
