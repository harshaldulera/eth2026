"use client";

import { useMemo, useSyncExternalStore } from "react";

/** sessionStorage key the replay's FORK INTO A NEW OP writes (replay-view.tsx re-exports it). */
export const FORK_KEY = "siege.fork";
export type ForkPayload = { from: string; castleId: string; lines: string[]; at: string };

const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return sessionStorage.getItem(FORK_KEY);
  } catch {
    return null;
  }
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Drop the forked script (the vault page's CLEAR, or once its lines are used up). */
export function clearFork() {
  try {
    sessionStorage.removeItem(FORK_KEY);
  } catch {
    /* private mode: nothing was stored */
  }
  listeners.forEach((fn) => fn());
}

/**
 * The op forked from a replay for this vault, if any: its operator lines become the DEMO LINE ✎
 * script in the Op room. Hydration-safe (server snapshot is null) and per tab.
 */
export function useFork(castleId: string | undefined): ForkPayload | null {
  const raw = useSyncExternalStore(subscribe, read, () => null);
  return useMemo(() => {
    if (!raw || !castleId) return null;
    try {
      const p = JSON.parse(raw) as ForkPayload;
      return p && p.castleId === castleId && Array.isArray(p.lines) && p.lines.length > 0 ? p : null;
    } catch {
      return null;
    }
  }, [raw, castleId]);
}
