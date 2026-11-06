"use client";

/**
 * Op-room scene effects, as one hoisted stylesheet (React 19 dedupes it by href). Global classes
 * prefixed `scn-`; colours are tokens only. Everything is either a one-shot that ends on its
 * resting state (the global reduced-motion rule shortens animations to ~0 ms, so they land on the
 * right final frame) or a slow idle loop.
 *
 * Not a CSS module: the project's Turbopack rule runs every .css through Tailwind as plain CSS,
 * which drops CSS-module class mapping.
 */

export const s = {
  backdrop: "scn-backdrop",
  badgePop: "scn-badgePop",
  bezel: "scn-bezel",
  bezelLockdown: "scn-bezelLockdown",
  chipPulse: "scn-chipPulse",
  coin: "scn-coin",
  flood: "scn-flood",
  floor: "scn-floor",
  floorEdge: "scn-floorEdge",
  iconPulse: "scn-iconPulse",
  led: "scn-led",
  ledBreach: "scn-ledBreach",
  ledFlag: "scn-ledFlag",
  ledHold: "scn-ledHold",
  ledIdle: "scn-ledIdle",
  ledLockdown: "scn-ledLockdown",
  ledThink: "scn-ledThink",
  screen: "scn-screen",
  shake: "scn-shake",
  shieldFlash: "scn-shieldFlash",
  strobeWash: "scn-strobeWash",
  takeover: "scn-takeover",
  tint: "scn-tint",
  vignette: "scn-vignette",
  wall: "scn-wall",
} as const;

const CSS = `.scn-bezel {
  position: relative;
  background: var(--color-raised);
  padding: 10px 10px 12px;
  box-shadow:
    0 -2px 0 0 var(--color-line),
    0 2px 0 0 var(--color-line),
    -2px 0 0 0 var(--color-line),
    2px 0 0 0 var(--color-line),
    inset 2px 2px 0 0 color-mix(in oklab, var(--color-glint) 8%, transparent),
    inset -2px -3px 0 0 color-mix(in oklab, var(--color-shade) 45%, transparent);
}
.scn-bezelLockdown {
  box-shadow:
    0 -2px 0 0 var(--color-threat),
    0 2px 0 0 var(--color-threat),
    -2px 0 0 0 var(--color-threat),
    2px 0 0 0 var(--color-threat),
    inset 2px 2px 0 0 color-mix(in oklab, var(--color-glint) 8%, transparent),
    inset -2px -3px 0 0 color-mix(in oklab, var(--color-shade) 45%, transparent);
}
.scn-screen {
  position: relative;
  overflow: hidden;
  background: var(--color-bg);
  box-shadow:
    inset 0 0 0 2px color-mix(in oklab, var(--color-shade) 60%, transparent),
    inset 0 0 24px color-mix(in oklab, var(--color-shade) 75%, transparent);
  isolation: isolate;
}
.scn-backdrop {
  position: absolute;
  inset: 0;
  z-index: 0;
  image-rendering: pixelated;
}
.scn-wall {
  position: absolute;
  inset: 0 0 34% 0;
  background-image: url("/pixel/tiny-dungeon/tiles/tile_0040.png");
  background-repeat: repeat;
  image-rendering: pixelated;
  filter: grayscale(0.55) brightness(0.55) contrast(1.05);
}
.scn-floor {
  position: absolute;
  inset: 66% 0 0 0;
  background-image: url("/pixel/tiny-dungeon/tiles/tile_0000.png");
  background-repeat: repeat;
  image-rendering: pixelated;
  filter: grayscale(0.6) brightness(0.45);
}
.scn-floorEdge {
  position: absolute;
  left: 0;
  right: 0;
  top: 66%;
  height: 3px;
  background: color-mix(in oklab, var(--color-bg) 70%, transparent);
}
.scn-tint {
  position: absolute;
  inset: 0;
  background: color-mix(in oklab, var(--color-accent) 14%, transparent);
  mix-blend-mode: color;
  pointer-events: none;
}
.scn-vignette {
  position: absolute;
  inset: 0;
  pointer-events: none;
  z-index: 30;
  background:
    repeating-linear-gradient(0deg, color-mix(in oklab, var(--color-shade) 18%, transparent) 0 1px, transparent 1px 3px),
    radial-gradient(ellipse 95% 85% at 50% 50%, transparent 55%, color-mix(in oklab, var(--color-shade) 55%, transparent) 100%);
}
.scn-led {
  width: 10px;
  height: 6px;
  background: color-mix(in oklab, var(--color-line) 80%, black);
}
.scn-ledIdle {
  background: var(--color-safe);
  box-shadow: 0 0 6px var(--color-safe);
}
.scn-ledThink {
  background: var(--color-warn);
  box-shadow: 0 0 6px var(--color-warn);
  animation: scn-led-think 0.8s steps(1, end) infinite;
}
.scn-ledFlag {
  background: var(--color-warn);
  box-shadow: 0 0 6px var(--color-warn);
}
.scn-ledHold {
  background: var(--color-safe);
  box-shadow: 0 0 8px var(--color-safe);
  animation: scn-led-blink-once 0.5s steps(1, end) 1 both;
}
.scn-ledLockdown {
  background: var(--color-threat);
  box-shadow: 0 0 8px var(--color-threat);
  animation: scn-led-strobe 333ms steps(1, end) 3 both;
}
.scn-ledBreach {
  background: var(--color-ink);
  box-shadow:
    0 0 10px var(--color-ink),
    0 0 4px var(--color-money);
}
@keyframes scn-led-think {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.35;
  }
}
@keyframes scn-led-blink-once {
  0% {
    opacity: 0.2;
  }
  40% {
    opacity: 1;
  }
  100% {
    opacity: 1;
  }
}
@keyframes scn-led-strobe {
  0% {
    opacity: 1;
  }
  50% {
    opacity: 0.12;
  }
  100% {
    opacity: 1;
  }
}
.scn-strobeWash {
  position: absolute;
  inset: 0;
  z-index: 25;
  pointer-events: none;
  background: color-mix(in oklab, var(--color-threat) 22%, transparent);
  animation: scn-wash-strobe 333ms steps(1, end) 3 both;
  opacity: 0.35;
}
@keyframes scn-wash-strobe {
  0% {
    opacity: 1;
  }
  50% {
    opacity: 0;
  }
  100% {
    opacity: 0.35;
  }
}
.scn-shieldFlash {
  position: absolute;
  pointer-events: none;
  box-shadow:
    0 0 0 3px var(--color-safe),
    0 0 18px 4px color-mix(in oklab, var(--color-safe) 60%, transparent);
  animation: scn-shield-flash 520ms steps(4, end) 1 both;
}
@keyframes scn-shield-flash {
  0% {
    opacity: 1;
    transform: scale(0.9);
  }
  100% {
    opacity: 0;
    transform: scale(1.12);
  }
}
.scn-badgePop {
  animation: scn-badge-pop 360ms steps(6, end) 1 both;
}
@keyframes scn-badge-pop {
  0% {
    transform: translateY(8px) scale(0.4);
    opacity: 0;
  }
  60% {
    transform: translateY(-3px) scale(1.15);
    opacity: 1;
  }
  100% {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
}
.scn-flood {
  position: absolute;
  inset: 0;
  z-index: 4;
  pointer-events: none;
  background: radial-gradient(
    ellipse 55% 70% at var(--door-x, 58%) 52%,
    color-mix(in oklab, var(--color-money) 55%, transparent) 0%,
    color-mix(in oklab, var(--color-money) 18%, transparent) 45%,
    transparent 75%
  );
  animation: scn-flood-in 900ms steps(9, end) 1 both;
}
@keyframes scn-flood-in {
  0% {
    opacity: 0;
  }
  100% {
    opacity: 1;
  }
}
.scn-shake {
  animation: scn-shake 90ms steps(2, end) 6;
}
@keyframes scn-shake {
  0% {
    transform: translate(2px, 0);
  }
  50% {
    transform: translate(-2px, 1px);
  }
  100% {
    transform: translate(0, 0);
  }
}
.scn-iconPulse {
  animation: scn-icon-pulse 300ms steps(3, end) 1 both;
}
@keyframes scn-icon-pulse {
  0% {
    opacity: 0;
  }
  50% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
.scn-chipPulse {
  animation: scn-chip-pulse 700ms steps(2, end) 2;
}
@keyframes scn-chip-pulse {
  0% {
    filter: brightness(1.8);
  }
  100% {
    filter: none;
  }
}
.scn-coin {
  position: absolute;
  width: 10px;
  height: 10px;
  background: var(--color-money);
  box-shadow:
    inset -2px -2px 0 0 color-mix(in oklab, var(--color-money) 55%, black),
    inset 2px 2px 0 0 color-mix(in oklab, var(--color-money) 40%, white),
    0 0 6px color-mix(in oklab, var(--color-money) 60%, transparent);
}
.scn-takeover {
  animation: scn-takeover-in 220ms steps(4, end) 1 both;
}
@keyframes scn-takeover-in {
  0% {
    clip-path: inset(50% 0 50% 0);
  }
  100% {
    clip-path: inset(0 0 0 0);
  }
}`;

/** Mount once anywhere in a scene (Stage, OpConsole). */
export function SceneStyles() {
  return (
    <style href="siege-scene" precedence="medium">
      {CSS}
    </style>
  );
}
