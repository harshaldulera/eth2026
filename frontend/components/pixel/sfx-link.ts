"use client";

/**
 * The shell's door to the sound engine (`lib/sfx`). Fire-and-forget: `play` is a no-op before the
 * first gesture and never throws, so a cue can never break a button.
 */
import { sfx, type PlayOptions } from "@/lib/sfx";

/** @example playCue("ui_blip") */
export function playCue(name: string | null | undefined, opts?: PlayOptions): void {
  if (!name) return;
  try {
    sfx.play(name, opts);
  } catch {
    /* sound is decoration */
  }
}

/** Resume the AudioContext; call from a user gesture. */
export function unlockSfx(): void {
  try {
    void sfx.unlock();
  } catch {
    /* ignore */
  }
}
