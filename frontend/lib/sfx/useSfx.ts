"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { getSfxEngine, type PlayOptions } from "./index";
import type { CueName } from "./cues";
import type { EngineSnapshot } from "./engine";

const SERVER: EngineSnapshot = { unlocked: false, muted: false };
const subscribe = (l: () => void) => getSfxEngine().subscribe(l);
const snapshot = () => getSfxEngine().getSnapshot();
const serverSnapshot = () => SERVER;

/**
 * Sound for components. `muted`/`unlocked` are hydration-safe (server and first client render see
 * `{ unlocked: false, muted: false }`).
 *
 * @example const { play, muted, toggleMute, unlock } = useSfx(); <button onClick={() => { void unlock(); play("ui_confirm"); }}>
 */
export function useSfx() {
  const { unlocked, muted } = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  const play = useCallback((name: CueName | (string & {}), opts?: PlayOptions) => getSfxEngine().play(name, opts), []);
  return useMemo(
    () => ({
      play,
      unlocked,
      muted,
      unlock: () => getSfxEngine().unlock(),
      mute: (m = true) => getSfxEngine().mute(m),
      toggleMute: () => getSfxEngine().toggleMute(),
      duck: (ms: number) => getSfxEngine().duck(ms),
    }),
    [play, unlocked, muted],
  );
}
