import { useSyncExternalStore } from "react";

/**
 * Integer pixel scale for sprites (plan §2.4): 2 on phones (< 640 px), 3 on desktops, 4 on the wall
 * (≥ 1800 × 1000, i.e. a 1080p screen in full-screen).
 */
export type PixelScale = 2 | 3 | 4;

export const PHONE_MAX = 640;
export const WALL_MIN_W = 1800;
export const WALL_MIN_H = 1000;
export const SERVER_SCALE: PixelScale = 3;

export function scaleForViewport(width: number, height = 900): PixelScale {
  if (width < PHONE_MAX) return 2;
  if (width >= WALL_MIN_W && height >= WALL_MIN_H) return 4;
  return 3;
}

const QUERIES = [`(max-width: ${PHONE_MAX - 0.02}px)`, `(min-width: ${WALL_MIN_W}px) and (min-height: ${WALL_MIN_H}px)`];

function subscribe(cb: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mqs = QUERIES.map((q) => window.matchMedia(q));
  mqs.forEach((m) => m.addEventListener?.("change", cb));
  return () => mqs.forEach((m) => m.removeEventListener?.("change", cb));
}

function snapshot(): PixelScale {
  if (typeof window === "undefined") return SERVER_SCALE;
  return scaleForViewport(window.innerWidth, window.innerHeight);
}

/**
 * Current pixel scale, updated on breakpoint changes. Hydration-safe: server and first client
 * render use 3.
 *
 * @example const scale = usePixelScale(); <Sprite name="coin" scale={scale} />
 */
export function usePixelScale(): PixelScale {
  return useSyncExternalStore(subscribe, snapshot, () => SERVER_SCALE);
}
