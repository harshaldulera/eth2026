"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Castle, Siege, StoredSiegeEvent } from "@/lib/types";
import { api, type SiegeDetail } from "@/lib/api/client";
import { usePolling } from "./usePolling";
import { useLiveEvents, type LiveEvents } from "./useLiveEvents";

const ENDED = new Set(["held", "broken", "banished"]);
/** Events after which the siege record has changed. */
const REFETCH_ON = new Set(["start", "decision", "end", "attempt", "release", "approval"]);

export type SiegeView = {
  siege: Siege | undefined;
  castle: Castle | undefined;
  events: StoredSiegeEvent[];
  /** A raider message has landed and the guardian has not answered it yet (any viewer sees this). */
  decisionInFlight: boolean;
  /** The siege ended and the chain result (fee split or payout) is still on its way. */
  awaitingChain: boolean;
  ended: boolean;
  mode: LiveEvents["mode"] | "demo";
  error: unknown;
  loading: boolean;
  refresh: () => Promise<void>;
  /** Replace the siege locally (after this tab sent a message); the next fetch overwrites it. */
  setSiege: (s: Siege) => void;
};

/** The worker will not produce an attempt/release any more. */
const settlementDone = (s: Siege) => s.settlement?.state === "failed" || s.settlement?.state === "void";

export function isAwaitingChain(s: Siege | undefined): boolean {
  if (!s || s.free || settlementDone(s)) return false;
  if (!ENDED.has(s.status)) return false;
  return s.status === "broken" ? !s.release : !s.attempt;
}

/**
 * True when the newest raider message has no guardian decision for the same turn yet. Only shows
 * while the engine emits `message` before calling the guardian; today both events arrive together,
 * so the Siege Room also checks the record (a raider message with no reply).
 */
export function inFlight(events: StoredSiegeEvent[], siege: Siege | undefined): boolean {
  if (!siege || ENDED.has(siege.status)) return false;
  let lastMessageTurn = 0;
  let lastDecisionTurn = 0;
  for (const e of events) {
    if (e.type === "message" && e.turn) lastMessageTurn = Math.max(lastMessageTurn, e.turn);
    if (e.type === "decision" && e.turn) lastDecisionTurn = Math.max(lastDecisionTurn, e.turn);
    if (e.type === "end") return false;
  }
  return lastMessageTurn > lastDecisionTurn;
}

/**
 * One siege, live: the record from GET /api/siege/[id], refetched whenever an event says it changed,
 * plus the event stream. Falls back to slow polling for changes that emit no event (a settlement
 * that failed or was voided). Pass `demo` to replay a recorded siege with no network at all.
 *
 * @example const { siege, castle, events, decisionInFlight } = useSiege(id);
 */
export function useSiege(siegeId: string, opts: { demo?: DemoSiege } = {}): SiegeView {
  const demo = useDemoSiege(opts.demo);
  const live = useLiveSiege(siegeId, !opts.demo);
  return opts.demo ? demo : live;
}

function useLiveSiege(siegeId: string, enabled: boolean): SiegeView {
  const [interval, setIntervalMs] = useState(1500);
  const detail = usePolling(() => api.siege(siegeId), interval, { key: siegeId, enabled: enabled && interval > 0 });
  const siege = detail.data?.siege;
  const awaitingChain = isAwaitingChain(siege);
  const ended = siege ? ENDED.has(siege.status) || siege.settlement?.state === "void" : false;
  // Events refetch at once; the poll covers what the stream cannot show. While a siege runs, the
  // record is the only place a raider message appears before the guardian answers (the siege
  // engine emits `message` together with `decision`), and a void from another raider's break emits
  // nothing on this siege. So keep the old cadence: agent sieges 1.2 s, human 4 s. Stop when final.
  const next = !siege ? 1500 : awaitingChain ? 1500 : ended ? 0 : siege.agentId ? 1200 : 4000;
  if (enabled && siege && next !== interval) setIntervalMs(next);

  const refreshRef = useRef(detail.refresh);
  useEffect(() => {
    refreshRef.current = detail.refresh;
  });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onEvent = useCallback((e: StoredSiegeEvent) => {
    if (!REFETCH_ON.has(e.type)) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void refreshRef.current(), 120); // coalesce a burst (decision + end)
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  const feed = useLiveEvents({ siegeId, enabled, onEvent });
  const decisionInFlight = useMemo(() => inFlight(feed.events, siege), [feed.events, siege]);
  const setSiege = useCallback((s: Siege) => detail.mutate((d) => (d ? { ...d, siege: s } : d)), [detail]);

  return {
    siege,
    castle: detail.data?.castle,
    events: feed.events,
    decisionInFlight,
    awaitingChain,
    ended,
    mode: feed.mode,
    error: detail.error,
    loading: detail.loading,
    refresh: detail.refresh,
    setSiege,
  };
}

// ─── Demo replay (?demo=1) ─────────────────────────────────────────────────

/** A recorded siege: the castle, and one frame per event with the siege as it stood after it. */
export type DemoSiege = {
  castle: Castle;
  frames: { delayMs: number; event: StoredSiegeEvent; siege: Siege }[];
};

function useDemoSiege(demo: DemoSiege | undefined): SiegeView {
  // The step belongs to one run; restarting bumps `run`, which makes a stale step read as 0.
  const [run, setRun] = useState(0);
  const [progress, setProgress] = useState({ run: 0, step: 0 });
  useEffect(() => {
    if (!demo) return;
    let i = 0;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      i += 1;
      setProgress({ run, step: i });
      if (i < demo.frames.length) t = setTimeout(tick, demo.frames[i]?.delayMs ?? 1000);
    };
    t = setTimeout(tick, demo.frames[0]?.delayMs ?? 800);
    return () => clearTimeout(t);
  }, [demo, run]);
  const step = progress.run === run ? progress.step : 0;

  const shown = demo ? demo.frames.slice(0, step) : [];
  const events = shown.map((f) => f.event);
  const siege = shown.length ? shown[shown.length - 1].siege : demo?.frames[0]?.siege && { ...demo.frames[0].siege, messages: [], turn: 0, status: "in_progress" as const };
  return {
    siege,
    castle: demo?.castle,
    events,
    decisionInFlight: inFlight(events, siege),
    awaitingChain: false,
    ended: siege ? ENDED.has(siege.status) : false,
    mode: "demo",
    error: undefined,
    loading: false,
    refresh: async () => setRun((r) => r + 1),
    setSiege: () => {},
  };
}

export type { SiegeDetail };
