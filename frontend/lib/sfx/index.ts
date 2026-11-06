import { SfxEngine, type PlayOptions } from "./engine";
import { CUES, CUE_NAMES, type ClipSource, type CueName, type Recipe } from "./cues";

export { SfxEngine, MAX_VOICES, type PlayOptions, type EngineDeps, type EngineSnapshot } from "./engine";
export { CUES, CUE_NAMES, isCueName, recipeSpan, type CueName, type Recipe, type Tone, type ClipSource, type Bus, type Wave } from "./cues";

let engine: SfxEngine | null = null;

/** The page-wide engine (created on first use; nothing touches Web Audio until `unlock()`). */
export function getSfxEngine(): SfxEngine {
  if (!engine) engine = new SfxEngine();
  return engine;
}

/**
 * The sound API. Safe anywhere (server included): every call is a no-op until a user gesture has
 * run `sfx.unlock()`, and `play` never throws.
 *
 * @example sfx.play("stamp_hold"); sfx.play("class_escalate", { rate: 1 + 0.12 * segment });
 */
export const sfx = {
  play: (name: CueName | (string & {}), opts?: PlayOptions) => getSfxEngine().play(name, opts),
  unlock: () => getSfxEngine().unlock(),
  isUnlocked: () => getSfxEngine().isUnlocked(),
  mute: (muted = true) => getSfxEngine().mute(muted),
  toggleMute: () => getSfxEngine().toggleMute(),
  isMuted: () => getSfxEngine().isMuted(),
  duck: (ms: number) => getSfxEngine().duck(ms),
  register: (name: string, source: Recipe | ClipSource) => getSfxEngine().register(name, source),
  list: () => getSfxEngine().list(),
  stopAll: () => getSfxEngine().stopAll(),
};

/**
 * Play every cue in order with a gap (dev tool: `window.__siegeSfx.playAll()` in the console).
 * Unlocks first; resolves when the last cue has started.
 */
export async function playAll(gapMs = 250, names: readonly string[] = CUE_NAMES): Promise<void> {
  const e = getSfxEngine();
  await e.unlock();
  for (const name of names) {
    e.play(name);
    const len = (CUES as Record<string, Recipe>)[name]?.length ?? 500;
    await new Promise((r) => setTimeout(r, len + gapMs));
  }
}

declare global {
  interface Window {
    __siegeSfx?: { playAll: (gapMs?: number) => Promise<void>; list: () => string[]; play: (name: string) => void };
  }
}

if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
  window.__siegeSfx = { playAll: (gap) => playAll(gap), list: () => getSfxEngine().list(), play: (n) => getSfxEngine().play(n) };
}
