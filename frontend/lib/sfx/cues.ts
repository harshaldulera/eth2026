/**
 * Chiptune cue recipes (plan §2.5). Pure data: the engine (`engine.ts`) turns each tone into
 * Web Audio nodes, tests validate every recipe without an AudioContext.
 *
 * Any cue can be replaced later by a CC0 clip with `sfx.register(name, { url })`; the recipe here
 * stays as the fallback until the clip has loaded.
 */

export type Wave = "sine" | "square" | "triangle" | "sawtooth" | "noise";

/**
 * One voice inside a cue. Times in ms from the cue start, frequencies in Hz.
 * Noise ignores `freq`/`to` (use `filter` to colour it).
 */
export type Tone = {
  wave: Wave;
  /** Start offset (ms). */
  at?: number;
  /** Length (ms), envelope included. */
  dur: number;
  freq?: number;
  /** Pitch slide target, reached at the end of the tone. */
  to?: number;
  slide?: "lin" | "exp";
  /** Peak gain, 0–1 (default 0.2). */
  gain?: number;
  /** Envelope attack / release (ms). Defaults: 3 ms / 60% of the tone. */
  attack?: number;
  release?: number;
  /** Stereo position −1…1. */
  pan?: number;
  detune?: number;
  filter?: { type: BiquadFilterType; freq: number; to?: number; q?: number };
  /** Amplitude LFO: `gate` is a hard on/off square (glitch), `tremolo` a sine wobble. */
  gate?: number;
  tremolo?: { rate: number; depth: number };
};

/**
 * ui: navigation blips (silent in the quiet profile) · bed: think/type ticks (ducked by stamps)
 * fx: game events · lead: cues that duck everything else (lockdown alarm, breach fanfare).
 */
export type Bus = "ui" | "bed" | "fx" | "lead";

export type Recipe = {
  bus: Bus;
  tones: Tone[];
  /** Documented length (ms); the engine frees the voice after it. */
  length: number;
  /** Minimum gap before the same cue may play again (default 150 ms). */
  retriggerMs?: number;
  /** Duck the other buses for this long (ms) when the cue starts. */
  duck?: number;
  /** Which buses `duck` lowers (default ui + bed + fx). */
  duckBuses?: Bus[];
  /** Quiet profile (reduced motion): "skip" silences the cue, otherwise it plays at 60%. */
  quiet?: "skip";
};

/** Clip replacement registered at runtime (`sfx.register(name, { url })`). */
export type ClipSource = { url: string; bus?: Bus; gain?: number; retriggerMs?: number };

export const CUE_NAMES = [
  "power_on",
  "ui_blip",
  "ui_confirm",
  "coin_pay",
  "recon_start",
  "send_ping",
  "packet_in",
  "class_authority",
  "class_override",
  "class_inject",
  "class_obfusc",
  "class_pressure",
  "class_escalate",
  "class_extract",
  "class_unknown",
  "think_tick",
  "type_tick",
  "stamp_hold",
  "stamp_flag",
  "alarm_lockdown",
  "breach_fanfare",
  "coins_out",
  "coins_sort",
  "freeze",
  "rank_up",
  "deploy",
  "radio_call",
  "approve",
  "deny",
  "wall_rotate",
] as const;

export type CueName = (typeof CUE_NAMES)[number];

export const DEFAULT_RETRIGGER_MS = 150;

// Notes (equal temperament, A4 = 440).
const C4 = 261.63, E4 = 329.63, G4 = 392.0, C5 = 523.25, E5 = 659.25, G5 = 783.99, B5 = 987.77;
const C6 = 1046.5, D6 = 1174.66, E6 = 1318.51;

/** One coin: a short B5 then a ringing E6 — the sound every game taught us means money. */
function coin(at: number, pan = 0, gain = 0.13): Tone[] {
  return [
    { wave: "square", at, dur: 40, freq: B5, gain, attack: 1, release: 10, pan },
    { wave: "square", at: at + 40, dur: 90, freq: E6, gain, attack: 1, release: 80, pan },
  ];
}

/** A snare: a noise crack over a short pitched body. */
function snare(at: number): Tone[] {
  return [
    { wave: "noise", at, dur: 110, gain: 0.28, attack: 1, release: 100, filter: { type: "highpass", freq: 1400 } },
    { wave: "triangle", at, dur: 70, freq: 220, to: 120, slide: "exp", gain: 0.3, attack: 1, release: 60 },
  ];
}

/** Accelerating clock ticks (tick / tock alternating). */
function ticks(): Tone[] {
  const gaps = [170, 140, 115, 95, 80, 66, 55, 46, 40];
  const out: Tone[] = [];
  let t = 0;
  for (let i = 0; i <= gaps.length; i++) {
    out.push({ wave: "square", at: t, dur: 14, freq: i % 2 ? 1500 : 2100, gain: 0.1 + i * 0.006, attack: 1, release: 10 });
    if (i < gaps.length) t += gaps[i];
  }
  return out;
}

/** Twelve coins 50 ms apart, spread across the stereo field. */
function coinShower(): Tone[] {
  const pans = [-0.6, 0.5, -0.2, 0.7, -0.7, 0.2, -0.4, 0.6, 0, -0.5, 0.4, -0.1];
  return pans.flatMap((p, i) => coin(i * 50, p, 0.11));
}

export const CUES: Readonly<Record<CueName, Recipe>> = {
  // first unmute, wall slide wipe: a CRT warming up, then the relay click
  power_on: {
    bus: "fx",
    length: 400,
    tones: [
      { wave: "sine", dur: 380, freq: 200, to: 900, slide: "exp", gain: 0.3, attack: 20, release: 90 },
      { wave: "triangle", dur: 380, freq: 100, to: 450, slide: "exp", gain: 0.12, attack: 20, release: 90 },
      { wave: "noise", at: 378, dur: 22, gain: 0.25, attack: 1, release: 18, filter: { type: "highpass", freq: 3000 } },
    ],
  },
  ui_blip: { bus: "ui", length: 60, quiet: "skip", tones: [{ wave: "square", dur: 60, freq: 880, gain: 0.08, attack: 2, release: 40 }] },
  ui_confirm: {
    bus: "ui",
    length: 120,
    quiet: "skip",
    tones: [
      { wave: "square", dur: 55, freq: 660, gain: 0.09, attack: 2, release: 20 },
      { wave: "square", at: 60, dur: 60, freq: 990, gain: 0.09, attack: 2, release: 45 },
    ],
  },
  // x402 settled / top-up approved: three rising coins
  coin_pay: {
    bus: "fx",
    length: 350,
    tones: [
      { wave: "square", dur: 55, freq: C6, gain: 0.15, attack: 1, release: 15 },
      { wave: "square", at: 60, dur: 55, freq: D6, gain: 0.15, attack: 1, release: 15 },
      { wave: "square", at: 120, dur: 230, freq: E6, gain: 0.16, attack: 1, release: 200 },
    ],
  },
  recon_start: { bus: "fx", length: 150, tones: [{ wave: "triangle", dur: 150, freq: G5, gain: 0.22, attack: 12, release: 120 }] },
  send_ping: { bus: "fx", length: 80, tones: [{ wave: "square", dur: 80, freq: 1200, gain: 0.08, attack: 1, release: 55 }] },
  packet_in: { bus: "fx", length: 180, tones: [{ wave: "triangle", dur: 180, freq: 220, to: 110, slide: "exp", gain: 0.4, attack: 4, release: 120 }] },

  // ── class effects ────────────────────────────────────────────────────────────────────
  // authority: a brassy rising saw, two detuned voices (a forged fanfare)
  class_authority: {
    bus: "fx",
    length: 500,
    tones: [
      { wave: "sawtooth", dur: 460, freq: 330, to: 660, slide: "exp", gain: 0.1, attack: 30, release: 160, filter: { type: "lowpass", freq: 1400, to: 3200, q: 2 } },
      { wave: "sawtooth", dur: 460, freq: 330, to: 660, slide: "exp", detune: 14, gain: 0.08, attack: 30, release: 160, filter: { type: "lowpass", freq: 1400, to: 3200, q: 2 } },
    ],
  },
  // override: a 20 Hz gated square, the guard's identity glitching
  class_override: {
    bus: "fx",
    length: 500,
    tones: [
      { wave: "square", dur: 500, freq: 180, gain: 0.11, gate: 20, attack: 2, release: 80 },
      { wave: "square", dur: 500, freq: 271, to: 240, gain: 0.06, gate: 20, attack: 2, release: 80 },
    ],
  },
  // injection: a packet thuds into the tray, with the click of the latch
  class_inject: {
    bus: "fx",
    length: 300,
    tones: [
      { wave: "sine", dur: 240, freq: 150, to: 52, slide: "exp", gain: 0.55, attack: 2, release: 180 },
      { wave: "noise", dur: 14, gain: 0.25, attack: 1, release: 10, filter: { type: "highpass", freq: 4000 } },
      { wave: "square", at: 200, dur: 30, freq: 1800, gain: 0.05, attack: 1, release: 20 },
    ],
  },
  // obfuscation: static sweeping up through a bandpass
  class_obfusc: {
    bus: "fx",
    length: 700,
    tones: [{ wave: "noise", dur: 700, gain: 0.3, attack: 40, release: 160, filter: { type: "bandpass", freq: 500, to: 4000, q: 2.5 } }],
  },
  // pressure: the wall clock ticks faster and faster
  class_pressure: { bus: "fx", length: 900, tones: ticks() },
  // escalation: one rising blip; callers pass rate = 1 + 0.12 × segment so each turn climbs
  class_escalate: {
    bus: "fx",
    length: 140,
    tones: [
      { wave: "square", dur: 60, freq: C5, gain: 0.1, attack: 1, release: 20 },
      { wave: "square", at: 55, dur: 85, freq: G5, gain: 0.1, attack: 1, release: 60 },
    ],
  },
  // extraction: a thin 1200 Hz whine with tremolo, the mirror humming
  class_extract: { bus: "fx", length: 600, tones: [{ wave: "sine", dur: 600, freq: 1200, gain: 0.16, attack: 60, release: 200, tremolo: { rate: 14, depth: 0.9 } }] },
  // unclassified: two soft blips (the "?" blinks twice)
  class_unknown: {
    bus: "fx",
    length: 260,
    tones: [
      { wave: "triangle", dur: 90, freq: 440, gain: 0.16, attack: 6, release: 60 },
      { wave: "triangle", at: 160, dur: 100, freq: 440, gain: 0.16, attack: 6, release: 70 },
    ],
  },

  // ── turn loop ────────────────────────────────────────────────────────────────────────
  think_tick: { bus: "bed", length: 10, retriggerMs: 100, quiet: "skip", tones: [{ wave: "sine", dur: 10, freq: 1500, gain: 0.05, attack: 1, release: 6 }] },
  type_tick: {
    bus: "bed",
    length: 15,
    retriggerMs: 33,
    quiet: "skip",
    tones: [{ wave: "noise", dur: 15, gain: 0.09, attack: 1, release: 10, filter: { type: "bandpass", freq: 2600, q: 1.5 } }],
  },
  // HOLD / deny: a rubber stamp hitting the desk
  stamp_hold: {
    bus: "fx",
    length: 120,
    duck: 300,
    duckBuses: ["bed"],
    tones: [
      { wave: "square", dur: 120, freq: 150, to: 80, slide: "exp", gain: 0.24, attack: 1, release: 90 },
      { wave: "noise", dur: 35, gain: 0.22, attack: 1, release: 30, filter: { type: "lowpass", freq: 1200 } },
    ],
  },
  stamp_flag: {
    bus: "fx",
    length: 160,
    duck: 300,
    duckBuses: ["bed"],
    tones: [
      { wave: "triangle", dur: 160, freq: 520, to: 780, slide: "exp", gain: 0.32, attack: 2, release: 70 },
      { wave: "noise", dur: 25, gain: 0.15, attack: 1, release: 20, filter: { type: "lowpass", freq: 1500 } },
    ],
  },
  // LOCKDOWN: a two-tone klaxon, three pulses
  alarm_lockdown: {
    bus: "lead",
    length: 900,
    duck: 1200,
    tones: [0, 1, 2, 3, 4, 5].map((i) => ({
      wave: "sawtooth" as const,
      at: i * 150,
      dur: 140,
      freq: i % 2 ? 349.23 : 440,
      gain: 0.3,
      attack: 4,
      release: 30,
      filter: { type: "lowpass" as const, freq: 2400, q: 1 },
    })),
  },
  // BREACH: a bright arpeggio into a C-major chord swell — a win, not a warning
  breach_fanfare: {
    bus: "lead",
    length: 1200,
    duck: 1400,
    tones: [
      { wave: "square", dur: 75, freq: C5, gain: 0.14, attack: 1, release: 20 },
      { wave: "square", at: 80, dur: 75, freq: E5, gain: 0.14, attack: 1, release: 20 },
      { wave: "square", at: 160, dur: 75, freq: G5, gain: 0.14, attack: 1, release: 20 },
      { wave: "square", at: 240, dur: 160, freq: C6, gain: 0.15, attack: 1, release: 60 },
      { wave: "triangle", at: 300, dur: 900, freq: C4, gain: 0.24, attack: 140, release: 420 },
      { wave: "triangle", at: 300, dur: 900, freq: E4, gain: 0.2, attack: 140, release: 420 },
      { wave: "triangle", at: 300, dur: 900, freq: G4, gain: 0.2, attack: 140, release: 420 },
      { wave: "square", at: 300, dur: 900, freq: C5, gain: 0.05, attack: 200, release: 450, tremolo: { rate: 6, depth: 0.3 } },
    ],
  },
  coins_out: { bus: "fx", length: 700, tones: coinShower() },
  // fee rail: one coin into each lane, Owner (L) · Vault (C) · Grid (R)
  coins_sort: { bus: "fx", length: 600, tones: [...coin(0, -0.8), ...coin(220, 0), ...coin(440, 0.8)] },
  // frozen for replay: two detuned voices sliding down
  freeze: {
    bus: "fx",
    length: 700,
    tones: [
      { wave: "triangle", dur: 680, freq: 880, to: 220, slide: "exp", gain: 0.2, attack: 10, release: 260 },
      { wave: "triangle", dur: 680, freq: 880, to: 220, slide: "exp", detune: -35, gain: 0.14, attack: 10, release: 260 },
    ],
  },
  rank_up: {
    bus: "fx",
    length: 600,
    tones: [
      { wave: "square", dur: 90, freq: C5, gain: 0.14, attack: 1, release: 20 },
      { wave: "square", at: 100, dur: 90, freq: E5, gain: 0.14, attack: 1, release: 20 },
      { wave: "square", at: 200, dur: 90, freq: G5, gain: 0.14, attack: 1, release: 20 },
      { wave: "square", at: 300, dur: 300, freq: C6, gain: 0.15, attack: 1, release: 220 },
    ],
  },
  deploy: { bus: "fx", length: 300, tones: [...snare(0), ...snare(170)] },
  // cap hit / pager arrival: the classic two-tone pager, twice
  radio_call: {
    bus: "fx",
    length: 700,
    tones: [0, 130, 400, 530].map((at, i) => ({ wave: "square" as const, at, dur: 120, freq: i % 2 ? 1300 : 1000, gain: 0.13, attack: 2, release: 20 })),
  },
  approve: { bus: "fx", length: 220, tones: [{ wave: "triangle", dur: 210, freq: 440, to: 880, slide: "exp", gain: 0.3, attack: 4, release: 90 }] },
  deny: { bus: "fx", length: 260, tones: [{ wave: "square", dur: 250, freq: 440, to: 220, slide: "exp", gain: 0.14, attack: 2, release: 90 }] },
  wall_rotate: { bus: "ui", length: 40, quiet: "skip", tones: [{ wave: "sine", dur: 40, freq: 660, gain: 0.12, attack: 2, release: 30 }] },
};

/** Total length of a recipe from its tones (ms). */
export function recipeSpan(r: Recipe): number {
  return r.tones.reduce((m, t) => Math.max(m, (t.at ?? 0) + t.dur), 0);
}

export function isCueName(name: string): name is CueName {
  return (CUE_NAMES as readonly string[]).includes(name);
}
