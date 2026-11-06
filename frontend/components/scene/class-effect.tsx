"use client";

import { Sprite } from "@/components/pixel/sprite";
import { BEAT_MS, BEAT_MS_REDUCED } from "@/lib/scene/beats";
import { CLASS_META, type AttackClass } from "@/lib/scene/classes";
import { CLASS_CUE_DELAY_MS } from "@/lib/scene/cues";
import type { SceneFrame } from "@/lib/scene/player";
import { cn } from "@/lib/utils";

/**
 * The eight class effects (design §4), drawn on the stage. Frame-driven: everything is a pure
 * function of how long ago the turn's packet started, so a replay scrubbed to any instant paints
 * exactly what the live op showed and nothing runs on its own timer.
 */

export type EffectClock = {
  cls: AttackClass;
  /** Referee label of the turn (intimidation shakes the frame). */
  label?: string;
  /** ms since the packet beat started. */
  sincePacket: number;
  /** ms into the class effect (negative before it starts). */
  t: number;
  /** Effect length. */
  len: number;
  /** 0–1 through the effect; only meaningful while `active`. */
  p: number;
  active: boolean;
  reduced: boolean;
  turn: number;
};

/** Where the current turn is in its packet → class window, or null outside packet/think beats. */
export function effectClock(frame: SceneFrame, reduced: boolean): EffectClock | null {
  const b = frame.beat;
  if (!b || (b.kind !== "packet" && b.kind !== "think")) return null;
  const packetMs = reduced ? BEAT_MS_REDUCED.packet : BEAT_MS.packet;
  const sincePacket = b.kind === "packet" ? frame.progress * b.durationMs : packetMs + frame.progress * b.durationMs;
  let op = undefined as SceneFrame["visibleMessages"][number] | undefined;
  for (let i = frame.visibleMessages.length - 1; i >= 0; i--) {
    const m = frame.visibleMessages[i];
    if (m.role === "operator" && m.turn === b.turn) {
      op = m;
      break;
    }
  }
  const cls = op?.cls ?? b.data.cls ?? "unclassified";
  const start = reduced ? 0 : CLASS_CUE_DELAY_MS;
  const len = reduced ? 300 : CLASS_META[cls].effectMs;
  const t = sincePacket - start;
  const active = t >= 0 && t <= len;
  return { cls, label: op?.label, sincePacket, t, len, p: active ? t / len : t < 0 ? 0 : 1, active, reduced, turn: b.turn };
}

/** Role override: the guard swaps to a hollow outline 6 times. */
export function guardHollow(c: EffectClock | null): boolean {
  return Boolean(c && c.active && !c.reduced && c.cls === "override" && Math.floor(c.p * 6) % 2 === 0);
}

/** Pressure: the wall clock spins 3 turns (12 frames). */
export function clockFrame(c: EffectClock | null): number {
  if (!c || !c.active || c.reduced || c.cls !== "pressure") return 0;
  return Math.floor(c.t / (c.len / 12)) % 4;
}

/** Intimidation shakes the whole monitor 2 px. */
export function shakes(c: EffectClock | null): boolean {
  return Boolean(c && c.active && !c.reduced && c.cls === "pressure" && /intimidation|threat/i.test(c.label ?? ""));
}

export type ClassEffectProps = {
  clock: EffectClock | null;
  /** Stage scale factor (1 room, 2 wall). */
  k?: number;
  /** Escalation segments filled before this turn's (this op). */
  escalation?: number;
};

const ease = (p: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, p)), 3);

/**
 * Overlay for the active class effect. Renders nothing outside the effect window.
 *
 * @example <ClassEffect clock={effectClock(frame, calm)} k={1} />
 */
export function ClassEffect({ clock: c, k = 1 }: ClassEffectProps) {
  if (!c || !c.active) return null;
  const meta = CLASS_META[c.cls];

  if (c.reduced) {
    // 300 ms opacity pulse of the class icon, centred
    return (
      <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center" style={{ opacity: Math.sin(Math.PI * c.p) }} aria-hidden>
        <Sprite name={meta.icon} scale={4 * k} />
      </div>
    );
  }

  const p = c.p;
  switch (meta.effect) {
    case "credential": {
      // forged credential slides in from the left; a red FORGED? blinks on it once it stops
      const x = -30 + 62 * ease(p / 0.35);
      const out = p > 0.88 ? (p - 0.88) / 0.12 : 0;
      return (
        <div className="pointer-events-none absolute inset-0 z-20" aria-hidden>
          <div className="absolute" style={{ left: `${x}%`, top: "26%", opacity: 1 - out, transform: "rotate(-4deg)" }}>
            <Sprite name="credential" frame={Math.floor(p * 6) % 2} scale={4 * k} />
            {p > 0.35 && Math.floor(p * 10) % 2 === 0 ? (
              <span
                className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 -rotate-12 border-2 border-threat bg-bg/80 px-1 font-pixel leading-none whitespace-nowrap text-threat"
                style={{ fontSize: 14 * k }}
              >
                FORGED?
              </span>
            ) : null}
          </div>
        </div>
      );
    }
    case "inbox": {
      // a spoofed packet drops into the inbox tray; its tag flips ? → SPOOF
      const y = -70 * (1 - ease(p / 0.4));
      return (
        <div className="pointer-events-none absolute right-[3%] bottom-[4%] z-20" style={{ width: 48 * k }} aria-hidden>
          <div className="absolute left-1/2 -translate-x-1/2" style={{ bottom: 30 * k, transform: `translate(-50%, ${y * k}px)` }}>
            <span className="block" style={{ filter: "drop-shadow(0 0 4px var(--color-threat))" }}>
              <Sprite name="packet" frame={1} scale={3 * k} />
            </span>
          </div>
          <span
            className={cn("absolute left-1/2 -translate-x-1/2 border-2 bg-bg/90 px-1 font-pixel leading-none whitespace-nowrap", p < 0.55 ? "border-ink-dim text-ink-dim" : "border-threat text-threat")}
            style={{ bottom: 56 * k, fontSize: 14 * k }}
          >
            {p < 0.55 ? "?" : "SPOOF"}
          </span>
        </div>
      );
    }
    case "static": {
      // noise fills the monitor, then clears from the centre outwards
      const r = p < 0.5 ? 0 : ((p - 0.5) / 0.5) * 80;
      const mask = r > 0 ? `radial-gradient(circle at 50% 50%, transparent ${r}%, black ${r + 1}%)` : undefined;
      const frame = Math.floor(c.t / 80) % 3;
      return (
        <div
          className="pointer-events-none absolute inset-0 z-20 grid content-start overflow-hidden opacity-90"
          style={{ maskImage: mask, WebkitMaskImage: mask, gridTemplateColumns: `repeat(8, ${64 * k}px)` }}
          aria-hidden
        >
          {Array.from({ length: 48 }, (_, i) => (
            <Sprite key={i} name="fx.static" frame={(frame + i) % 3} scale={4 * k} />
          ))}
        </div>
      );
    }
    case "bar":
      // the escalation bar lives in the stage HUD (it persists); nothing extra here
      return null;
    case "mirror": {
      // a mirror rises in front of the guard; its reflection is a padlock
      const rise = 1 - ease(p / 0.35);
      const out = p > 0.85 ? (p - 0.85) / 0.15 : 0;
      return (
        <div className="pointer-events-none absolute bottom-[8%] left-[30%] z-20" style={{ transform: `translateY(${rise * 110}%)`, opacity: 1 - out }} aria-hidden>
          <span className="relative block">
            <Sprite name="mirror" frame={Math.floor(p * 8) % 2} scale={5 * k} />
            <span className="absolute inset-0 grid place-items-center" style={{ paddingBottom: 10 * k }}>
              <Sprite name="padlock" scale={2 * k} />
            </span>
          </span>
        </div>
      );
    }
    case "question": {
      // ? blinks over the inbox twice
      const on = Math.floor(p * 4) % 2 === 0;
      return (
        <div className="pointer-events-none absolute right-[3%] bottom-[4%] z-20 grid place-items-center" style={{ width: 48 * k, height: 48 * k }} aria-hidden>
          <span className="absolute font-pixel leading-none text-warn" style={{ fontSize: 28 * k, bottom: 46 * k, opacity: on ? 1 : 0 }}>
            ?
          </span>
        </div>
      );
    }
    case "clock": {
      // the wall clock steps forward over the bricks (3 hard steps), spins three turns, steps back
      const inP = Math.min(1, p / 0.18);
      const outP = p > 0.82 ? (p - 0.82) / 0.18 : 0;
      const step = (v: number) => Math.floor(v * 3) / 3;
      const scale = 0.4 + 0.6 * step(inP) - 0.6 * step(outP);
      const on = scale > 0.45;
      return (
        <div className="pointer-events-none absolute inset-x-0 top-[6%] z-20 grid place-items-center" aria-hidden>
          <span
            className="block"
            style={{
              transform: `scale(${scale})`,
              transformOrigin: "50% 50%",
              opacity: on ? 1 : 0,
              filter: "drop-shadow(0 0 6px var(--color-threat))",
            }}
          >
            <Sprite name="clock" frame={clockFrame(c)} scale={5 * k} />
          </span>
        </div>
      );
    }
    // flicker (override) acts on the guard itself
    default:
      return null;
  }
}

/** Packet flight: composer (bottom right, off-screen) → inbox tray, over the first 350 ms. */
export function PacketFlight({ clock: c, k = 1 }: { clock: EffectClock | null; k?: number }) {
  if (!c || c.reduced || c.sincePacket > CLASS_CUE_DELAY_MS) return null;
  const p = ease(c.sincePacket / CLASS_CUE_DELAY_MS);
  // start below-right of the screen, arc into the tray
  const x = 30 * (1 - p);
  const y = 60 * (1 - p) - 30 * Math.sin(Math.PI * p);
  return (
    <div className="pointer-events-none absolute right-[5%] bottom-[10%] z-20" style={{ transform: `translate(${x * k}px, ${y * k}px)` }} aria-hidden>
      <Sprite name="packet" frame={Math.floor(c.sincePacket / 90) % 2} scale={3 * k} />
    </div>
  );
}
