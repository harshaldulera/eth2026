"use client";

/**
 * J4: ops a red teamer TYPES from this browser but pays from one of their units. The siege carries
 * the unit's agentId (the payout lands in the unit), so the op room would otherwise treat it as an
 * autonomous run and only let you watch. This browser remembers which ops it started by hand;
 * the per-op turn-token cookie set by /api/play/start is what actually authorises the messages.
 *
 *   localStorage "siege.handOps" = ["siege_…", …]   (newest last, at most 50)
 */
import { useSyncExternalStore } from "react";

export const HAND_OPS_STORAGE = "siege.handOps";
const EVENT = "siege:hand-ops";
const MAX = 50;

function read(): string[] {
  try {
    const v: unknown = JSON.parse(window.localStorage.getItem(HAND_OPS_STORAGE) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Remember that this browser started `siegeId` by hand (call right after a unit-paid start). */
export function rememberHandOp(siegeId: string): void {
  try {
    const next = [...read().filter((x) => x !== siegeId), siegeId].slice(-MAX);
    window.localStorage.setItem(HAND_OPS_STORAGE, JSON.stringify(next));
    window.dispatchEvent(new Event(EVENT));
  } catch {}
}

function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}

/** Did this browser start `siegeId` by hand? False on the server and until hydrated. */
export function useHandOp(siegeId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => read().includes(siegeId),
    () => false,
  );
}
