"use client";

import { useSyncExternalStore } from "react";
import { getPrefs, getServerPrefs, setPref, subscribePrefs, type PrefKey, type Prefs } from "@/lib/pixel/prefs";

export type PrefsState = Prefs & { set: <K extends PrefKey>(key: K, value: Prefs[K]) => void };

/**
 * Skin, CRT, mute and calm prefs, shared by every caller.
 *
 * Hydration-safe: the server and the first client render see the defaults (CRT skin, CRT on,
 * sound on, calm off); the real values arrive on the next render. The page itself never flashes,
 * because the inline bootstrap script already put the attributes on <html> before paint.
 *
 * @example const { skin, set } = usePrefs(); set("skin", skin === "crt" ? "neon" : "crt");
 */
export function usePrefs(): PrefsState {
  const prefs = useSyncExternalStore(subscribePrefs, getPrefs, getServerPrefs);
  return { ...prefs, set: setPref };
}

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribeMotion(cb: () => void) {
  const mq = window.matchMedia?.(QUERY);
  mq?.addEventListener?.("change", cb);
  const off = subscribePrefs(cb);
  return () => {
    mq?.removeEventListener?.("change", cb);
    off();
  };
}

function motionSnapshot() {
  return getPrefs().calm || Boolean(window.matchMedia?.(QUERY).matches);
}

/**
 * True when motion should be stilled: the OS asks for reduced motion or `?calm=1` / the calm toggle.
 * Server render (and the first client render) assume full motion.
 *
 * @example const still = useCalmMotion(); <motion.div animate={still ? {} : { scale: [1.6, 1] }} />
 */
export function useCalmMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, motionSnapshot, () => false);
}
