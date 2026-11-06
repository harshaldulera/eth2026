"use client";

import { useCallback, useEffect, useRef } from "react";
import { playCue } from "@/components/pixel/sfx-link";
import type { Beat } from "@/lib/scene/beats";
import { cuesForBeat } from "@/lib/scene/cues";
import type { SceneFrame } from "@/lib/scene/player";

const THINK_TICK_MS = 400;
const TYPE_TICK_MS = 70;

/**
 * Beat cues for a scene: returns the `onBeatStart` to hand to usePlayer (packet, class 350 ms later,
 * stamp, coins, freeze). Delayed cues are cleared on unmount. Cues are no-ops until a gesture has
 * unlocked audio.
 *
 * @example const onBeatStart = useBeatCues(beats); const { frame } = usePlayer(beats, "live", { onBeatStart });
 */
export function useBeatCues(beats: readonly Beat[], enabled = true) {
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const beatsRef = useRef(beats);
  useEffect(() => {
    beatsRef.current = beats;
  }, [beats]);

  useEffect(() => {
    const set = timers.current;
    return () => {
      set.forEach(clearTimeout);
      set.clear();
    };
  }, []);

  return useCallback(
    (beat: Beat) => {
      if (!enabled) return;
      for (const c of cuesForBeat(beat, beatsRef.current)) {
        if (!c.delayMs) {
          playCue(c.name, c.opts);
          continue;
        }
        const t = setTimeout(() => {
          timers.current.delete(t);
          playCue(c.name, c.opts);
        }, c.delayMs);
        timers.current.add(t);
      }
    },
    [enabled],
  );
}

/**
 * The scene's running ticks: `think_tick` every 400 ms while the guard thinks, throttled
 * `type_tick`s while a reply types. Both stop with the component (and with an Activity hide).
 *
 * @example useTickSounds(frame);
 */
export function useTickSounds(frame: SceneFrame, enabled = true) {
  const thinking = enabled && frame.beat?.kind === "think";
  useEffect(() => {
    if (!thinking) return;
    const id = setInterval(() => playCue("think_tick"), THINK_TICK_MS);
    return () => clearInterval(id);
  }, [thinking]);

  const lastType = useRef(0);
  const typing = enabled && frame.beat?.kind === "reply" ? frame.typedChars : -1;
  useEffect(() => {
    if (typing <= 0) return;
    const now = performance.now();
    if (now - lastType.current < TYPE_TICK_MS) return;
    lastType.current = now;
    playCue("type_tick");
  }, [typing]);
}
