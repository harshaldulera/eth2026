"use client";

import { useEffect, useEffectEvent, useLayoutEffect, useMemo, useReducer, useRef } from "react";
import type { Beat } from "./beats";
import { frame, initialPlayer, isWaiting, playerReducer, type PlayerMode, type PlayerState, type SceneFrame } from "./player";

/** An unmount + remount closer than this is React StrictMode, not Activity hiding the route. */
const STRICT_REMOUNT_MS = 50;

export type PlayerControls = {
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (index: number) => void;
  step: (delta: number) => void;
  stepTurn: (delta: number) => void;
  setSpeed: (speed: number) => void;
};

export type UsePlayerOptions = {
  /** Fires once per beat as it starts (cue sounds, class effects). Not fired for beats skipped on load. */
  onBeatStart?: (beat: Beat, index: number) => void;
  /** Replay: start playing immediately (default false: the scrubber's play button starts it). */
  autoPlay?: boolean;
};

/**
 * Drive a scene from beats (plan §2.6). One requestAnimationFrame loop, running only while there
 * is something to animate; it stops when the component unmounts or its route is hidden by
 * Activity, and a hidden replay is paused so coming back never resumes sound by itself.
 *
 * @example const { frame, controls } = usePlayer(toBeats(siege, events, castle, { mode: "live" }), "live", { onBeatStart: (b) => cueFor(b) });
 */
export function usePlayer(beats: readonly Beat[], mode: PlayerMode, opts: UsePlayerOptions = {}) {
  const [state, dispatch] = useReducer(playerReducer, undefined, (): PlayerState => {
    const s = initialPlayer(mode, beats);
    return mode === "replay" && opts.autoPlay ? { ...s, playing: true } : s;
  });

  // Mode switch (rare: an op ends and the page swaps to replay) resets the player.
  const modeRef = useRef(mode);
  useEffect(() => {
    if (modeRef.current === mode) return;
    modeRef.current = mode;
    dispatch({ type: "reset", mode, beats });
  }, [mode, beats]);

  const beatsRef = useRef(beats);
  useEffect(() => {
    beatsRef.current = beats;
    dispatch({ type: "sync", beats });
  }, [beats]);

  const waiting = isWaiting(beats, state);
  const running = state.playing && !waiting;

  const tick = useEffectEvent((dt: number) => dispatch({ type: "tick", dt, beats }));
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      // clamp: a backgrounded tab must not fast-forward a whole op in one frame
      const dt = Math.min(now - last, 100);
      last = now;
      tick(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running]);

  // Replay: pause when hidden (Activity) or unmounted, so coming back never resumes sound by itself.
  // StrictMode's instant unmount/remount is not a hide: playback that was running carries on.
  const playingRef = useRef(state.playing);
  useEffect(() => {
    playingRef.current = state.playing;
  }, [state.playing]);
  const hidden = useRef<{ at: number; wasPlaying: boolean } | null>(null);
  useLayoutEffect(() => {
    if (mode !== "replay") return;
    const h = hidden.current;
    if (h && h.wasPlaying && performance.now() - h.at < STRICT_REMOUNT_MS) dispatch({ type: "play" });
    hidden.current = null;
    return () => {
      hidden.current = { at: performance.now(), wasPlaying: playingRef.current };
      dispatch({ type: "pause" });
    };
  }, [mode]);

  const beat = beats[state.index];
  const beatKey = beat ? `${state.index}:${beat.id}` : "";
  const fire = useEffectEvent((b: Beat, i: number) => opts.onBeatStart?.(b, i));
  // The beat shown on mount (live: the newest, already played) does not fire; each later one fires once.
  const fired = useRef(beatKey);
  useEffect(() => {
    if (fired.current === beatKey) return;
    fired.current = beatKey;
    if (beat) fire(beat, state.index);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire once per beat change
  }, [beatKey]);

  const controls = useMemo<PlayerControls>(
    () => ({
      play: () => dispatch({ type: "play", beats: beatsRef.current }),
      pause: () => dispatch({ type: "pause" }),
      toggle: () => dispatch({ type: "toggle", beats: beatsRef.current }),
      seek: (index) => dispatch({ type: "seek", index, beats: beatsRef.current }),
      step: (delta) => dispatch({ type: "step", delta, beats: beatsRef.current }),
      stepTurn: (delta) => dispatch({ type: "stepTurn", delta, beats: beatsRef.current }),
      setSpeed: (speed) => dispatch({ type: "speed", speed }),
    }),
    [],
  );
  const f: SceneFrame = useMemo(() => frame(beats, state), [beats, state]);
  return { frame: f, state, beat: beat ?? null, waiting, controls };
}
