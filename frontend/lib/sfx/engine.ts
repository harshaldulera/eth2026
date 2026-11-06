import { CUES, CUE_NAMES, DEFAULT_RETRIGGER_MS, recipeSpan, type Bus, type ClipSource, type Recipe, type Tone } from "./cues";
import { getPrefs, onPrefChange, setPref } from "@/lib/pixel/prefs";

/**
 * Web Audio engine for the chiptune cues (plan §2.5).
 *
 *  - The AudioContext is created lazily inside `unlock()`, which callers run from a user gesture
 *    (`<SfxBoot/>` listens for the first pointerdown/keydown). Before that `play()` is a no-op.
 *  - Routing: voice → bus (ui / bed / fx / lead) → master (−6 dB) → destination.
 *  - At most 8 voices; the oldest is stolen. A cue never retriggers within 150 ms (per-cue override).
 *  - `play()` never throws and is safe to call during SSR.
 *  - Mute lives in the shared prefs store (localStorage "siege.sfx.muted"), so the HUD toggle and
 *    the engine always agree.
 *  - Quiet profile under reduced motion / `?calm=1`: UI blips and ticks are silent, the rest at 60%.
 */

export const MAX_VOICES = 8;
const MASTER_GAIN = 0.5; // −6 dB
const QUIET_GAIN = 0.6;
const DUCK_LEVEL = 0.25;

export type PlayOptions = { gain?: number; rate?: number; pan?: number };

type Entry = { recipe?: Recipe; clip?: ClipSource & { buffer?: AudioBuffer; loading?: Promise<void>; failed?: boolean } };

type Voice = {
  id: number;
  name: string;
  startedAt: number;
  endsAt: number;
  out: GainNode;
  sources: AudioScheduledSourceNode[];
};

export type EngineSnapshot = { unlocked: boolean; muted: boolean };

export type EngineDeps = {
  /** Creates the AudioContext (tests pass a fake). */
  createContext?: () => AudioContext | null;
  /** Wall clock in ms for the retrigger guard. */
  now?: () => number;
  /** Reduced motion / calm. */
  quiet?: () => boolean;
  /** Fetch for clip sources. */
  fetch?: typeof fetch;
};

function defaultContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctor ? new Ctor({ latencyHint: "interactive" }) : null;
}

function defaultQuiet(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (getPrefs().calm || document.documentElement.getAttribute("data-calm") === "1") return true;
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  } catch {
    return false;
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class SfxEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buses: Partial<Record<Bus, GainNode>> = {};
  private noise: AudioBuffer | null = null;
  private voices: Voice[] = [];
  private nextId = 1;
  private last = new Map<string, number>();
  private registry = new Map<string, Entry>();
  private unlocked = false;
  private listeners = new Set<() => void>();
  private snapshot: EngineSnapshot = { unlocked: false, muted: false };
  private prefsBound = false;
  private deps: Required<Omit<EngineDeps, "fetch">> & { fetch?: typeof fetch };

  constructor(deps: EngineDeps = {}) {
    this.deps = {
      createContext: deps.createContext ?? defaultContext,
      now: deps.now ?? (() => (typeof performance !== "undefined" ? performance.now() : Date.now())),
      quiet: deps.quiet ?? defaultQuiet,
      fetch: deps.fetch ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined),
    };
    for (const name of CUE_NAMES) this.registry.set(name, { recipe: CUES[name] });
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────────────────

  /** Create/resume the AudioContext. Call from a user gesture. Resolves true once audio can play. */
  async unlock(): Promise<boolean> {
    try {
      this.bindPrefs();
      if (!this.ctx) {
        const ctx = this.deps.createContext();
        if (!ctx) return false;
        this.ctx = ctx;
        this.build(ctx);
      }
      if (this.ctx.state === "suspended") await this.ctx.resume();
      this.unlocked = this.ctx.state === "running";
      this.emit();
      return this.unlocked;
    } catch {
      return false;
    }
  }

  isUnlocked(): boolean {
    return this.unlocked;
  }

  private build(ctx: AudioContext) {
    const master = ctx.createGain();
    master.gain.value = this.isMuted() ? 0 : MASTER_GAIN;
    master.connect(ctx.destination);
    this.master = master;
    for (const bus of ["ui", "bed", "fx", "lead"] as Bus[]) {
      const g = ctx.createGain();
      g.gain.value = 1;
      g.connect(master);
      this.buses[bus] = g;
    }
  }

  private bindPrefs() {
    if (this.prefsBound || typeof window === "undefined") return;
    this.prefsBound = true;
    onPrefChange((key, prefs) => {
      if (key === "muted") this.applyMute(prefs.muted);
      else if (key === "calm") this.emit();
    });
  }

  // ─── mute ───────────────────────────────────────────────────────────────────────────

  isMuted(): boolean {
    try {
      return getPrefs().muted;
    } catch {
      return false;
    }
  }

  /** Mute or unmute; persisted under "siege.sfx.muted". */
  mute(muted = true): void {
    try {
      this.bindPrefs();
      setPref("muted", muted);
    } catch {
      /* storage blocked: still applies for this page */
    }
    this.applyMute(muted);
  }

  toggleMute(): boolean {
    const next = !this.isMuted();
    this.mute(next);
    return next;
  }

  private applyMute(muted: boolean) {
    const ctx = this.ctx;
    if (ctx && this.master) {
      try {
        const p = this.master.gain;
        p.cancelScheduledValues(ctx.currentTime);
        p.setTargetAtTime(muted ? 0 : MASTER_GAIN, ctx.currentTime, 0.015);
      } catch {
        /* ignore */
      }
    }
    if (muted) this.stopAll();
    this.emit();
  }

  // ─── registry ───────────────────────────────────────────────────────────────────────

  /** Add or replace a cue: a synth recipe, or a clip URL (the old recipe stays the fallback). */
  register(name: string, source: Recipe | ClipSource): void {
    const prev = this.registry.get(name) ?? {};
    if ("url" in source) {
      this.registry.set(name, { recipe: prev.recipe, clip: { ...source } });
      if (this.ctx) void this.loadClip(name);
    } else {
      this.registry.set(name, { recipe: source });
    }
  }

  list(): string[] {
    return [...this.registry.keys()];
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  private async loadClip(name: string): Promise<void> {
    const entry = this.registry.get(name);
    const clip = entry?.clip;
    if (!clip || clip.buffer || clip.failed || !this.ctx) return;
    if (!clip.loading) {
      const ctx = this.ctx;
      const f = this.deps.fetch;
      clip.loading = (async () => {
        try {
          if (!f) throw new Error("no fetch");
          const res = await f(clip.url);
          if (!res.ok) throw new Error(String(res.status));
          clip.buffer = await ctx.decodeAudioData(await res.arrayBuffer());
        } catch {
          clip.failed = true;
        }
      })();
    }
    return clip.loading;
  }

  // ─── playback ───────────────────────────────────────────────────────────────────────

  /** Play a cue. No-op before unlock, while muted, or for unknown names. Never throws. */
  play(name: string, opts: PlayOptions = {}): void {
    try {
      const ctx = this.ctx;
      if (!ctx || !this.unlocked || this.isMuted()) return;
      if (ctx.state !== "running") return;
      const entry = this.registry.get(name);
      if (!entry) return;
      const quiet = this.deps.quiet();
      const recipe = entry.recipe;
      if (quiet && recipe?.quiet === "skip") return;

      const retrigger = entry.clip?.retriggerMs ?? recipe?.retriggerMs ?? DEFAULT_RETRIGGER_MS;
      const now = this.deps.now();
      const prev = this.last.get(name);
      if (prev !== undefined && now - prev < retrigger) return;

      const clip = entry.clip;
      if (clip && !clip.buffer && !clip.failed) void this.loadClip(name);
      const useClip = Boolean(clip?.buffer);
      if (!useClip && !recipe) return;
      this.last.set(name, now);

      this.prune();
      while (this.voices.length >= MAX_VOICES) this.steal();

      const gainMul = clamp(opts.gain ?? 1, 0, 2) * (quiet ? QUIET_GAIN : 1);
      const rate = clamp(opts.rate ?? 1, 0.25, 4);
      const t0 = ctx.currentTime + 0.005;
      const busName: Bus = (useClip ? clip!.bus : undefined) ?? recipe?.bus ?? "fx";
      const bus = this.buses[busName] ?? this.master!;
      const out = ctx.createGain();
      out.gain.value = 1;
      if (opts.pan !== undefined && typeof ctx.createStereoPanner === "function") {
        const p = ctx.createStereoPanner();
        p.pan.value = clamp(opts.pan, -1, 1);
        out.connect(p);
        p.connect(bus);
      } else {
        out.connect(bus);
      }

      const sources: AudioScheduledSourceNode[] = [];
      let lastSource: AudioScheduledSourceNode | null = null;
      let lastStop = -1;
      const track = (made: { nodes: AudioScheduledSourceNode[]; stopAt: number }) => {
        sources.push(...made.nodes);
        if (made.stopAt > lastStop) {
          lastStop = made.stopAt;
          lastSource = made.nodes[0] ?? null;
        }
      };
      let lengthMs: number;
      if (useClip) {
        const src = ctx.createBufferSource();
        src.buffer = clip!.buffer!;
        src.playbackRate.value = rate;
        const g = ctx.createGain();
        g.gain.value = (clip!.gain ?? 1) * gainMul;
        src.connect(g);
        g.connect(out);
        src.start(t0);
        lengthMs = (clip!.buffer!.duration / rate) * 1000;
        track({ nodes: [src], stopAt: t0 + lengthMs / 1000 });
      } else {
        for (const tone of recipe!.tones) track(this.tone(ctx, out, tone, t0, gainMul, rate));
        lengthMs = Math.max(recipe!.length, recipeSpan(recipe!));
        if (recipe!.duck) this.duck(recipe!.duck, recipe!.duckBuses);
      }

      const voice: Voice = { id: this.nextId++, name, startedAt: t0, endsAt: t0 + lengthMs / 1000 + 0.05, out, sources };
      this.voices.push(voice);
      const endSource = lastSource as AudioScheduledSourceNode | null;
      if (endSource) endSource.onended = () => this.release(voice.id);
    } catch {
      /* sound must never break the game */
    }
  }

  /** Lower the other buses for `ms` (lockdown / breach / stamps). */
  duck(ms: number, buses: Bus[] = ["ui", "bed", "fx"]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      const t = ctx.currentTime;
      for (const b of buses) {
        const g = this.buses[b];
        if (!g) continue;
        g.gain.cancelScheduledValues(t);
        g.gain.setTargetAtTime(DUCK_LEVEL, t, 0.02);
        g.gain.setTargetAtTime(1, t + ms / 1000, 0.08);
      }
    } catch {
      /* ignore */
    }
  }

  /** Voices currently allocated (≤ MAX_VOICES). */
  activeVoices(): number {
    this.prune();
    return this.voices.length;
  }

  stopAll(): void {
    while (this.voices.length) this.steal();
    this.emit();
  }

  private tone(ctx: AudioContext, dest: AudioNode, tone: Tone, t0: number, gainMul: number, rate: number): { nodes: AudioScheduledSourceNode[]; stopAt: number } {
    const start = t0 + (tone.at ?? 0) / 1000;
    const dur = Math.max(0.005, tone.dur / 1000);
    const end = start + dur;
    const peak = clamp((tone.gain ?? 0.2) * gainMul, 0, 1);
    const attack = Math.min((tone.attack ?? 3) / 1000, dur * 0.5);
    const release = Math.min((tone.release ?? tone.dur * 0.6) / 1000, dur - attack);

    const env = ctx.createGain();
    env.gain.value = 0;
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + attack);
    env.gain.setValueAtTime(peak, end - release);
    env.gain.linearRampToValueAtTime(0, end);

    const made: AudioScheduledSourceNode[] = [];
    let src: AudioScheduledSourceNode;
    if (tone.wave === "noise") {
      const b = ctx.createBufferSource();
      b.buffer = this.noiseBuffer(ctx);
      b.loop = true;
      b.playbackRate.value = rate;
      src = b;
    } else {
      const o = ctx.createOscillator();
      o.type = tone.wave;
      const f0 = clamp((tone.freq ?? 440) * rate, 20, 20000);
      o.frequency.setValueAtTime(f0, start);
      if (tone.to) {
        const f1 = clamp(tone.to * rate, 20, 20000);
        if (tone.slide === "exp") o.frequency.exponentialRampToValueAtTime(f1, end);
        else o.frequency.linearRampToValueAtTime(f1, end);
      }
      if (tone.detune) o.detune.value = tone.detune;
      src = o;
    }
    made.push(src);

    let node: AudioNode = src;
    if (tone.filter) {
      const f = ctx.createBiquadFilter();
      f.type = tone.filter.type;
      f.frequency.setValueAtTime(tone.filter.freq, start);
      if (tone.filter.to) f.frequency.exponentialRampToValueAtTime(tone.filter.to, end);
      if (tone.filter.q !== undefined) f.Q.value = tone.filter.q;
      node.connect(f);
      node = f;
    }

    const lfoSpec = tone.gate ? { rate: tone.gate, depth: 1, wave: "square" as const } : tone.tremolo ? { ...tone.tremolo, wave: "sine" as const } : null;
    if (lfoSpec) {
      const mod = ctx.createGain();
      const depth = clamp(lfoSpec.depth, 0, 1);
      mod.gain.value = 1 - depth / 2;
      const lfo = ctx.createOscillator();
      lfo.type = lfoSpec.wave;
      lfo.frequency.value = lfoSpec.rate;
      const amt = ctx.createGain();
      amt.gain.value = depth / 2;
      lfo.connect(amt);
      amt.connect(mod.gain);
      node.connect(mod);
      node = mod;
      lfo.start(start);
      lfo.stop(end + 0.02);
      made.push(lfo);
    }

    node.connect(env);
    let tail: AudioNode = env;
    if (tone.pan && typeof ctx.createStereoPanner === "function") {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(tone.pan, -1, 1);
      env.connect(p);
      tail = p;
    }
    tail.connect(dest);
    src.start(start);
    src.stop(end + 0.02);
    return { nodes: made, stopAt: end + 0.02 };
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noise) return this.noise;
    const len = Math.floor(ctx.sampleRate * 1);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    let seed = 0x5eed;
    for (let i = 0; i < len; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      data[i] = (seed / 0xffffffff) * 2 - 1;
    }
    this.noise = buf;
    return buf;
  }

  private prune() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.voices = this.voices.filter((v) => {
      if (v.endsAt > t) return true;
      this.disconnect(v);
      return false;
    });
  }

  private release(id: number) {
    const i = this.voices.findIndex((v) => v.id === id);
    if (i < 0) return;
    const [v] = this.voices.splice(i, 1);
    this.disconnect(v);
  }

  /** Stop the oldest voice with a 5 ms fade so it doesn't click. */
  private steal() {
    const v = this.voices.shift();
    if (!v) return;
    const ctx = this.ctx;
    try {
      if (ctx) {
        v.out.gain.cancelScheduledValues(ctx.currentTime);
        v.out.gain.setTargetAtTime(0, ctx.currentTime, 0.005);
      }
      for (const s of v.sources) {
        s.onended = null;
        try {
          s.stop(ctx ? ctx.currentTime + 0.03 : 0);
        } catch {
          /* already stopped */
        }
      }
    } catch {
      /* ignore */
    }
    setTimeout(() => this.disconnect(v), 40);
  }

  private disconnect(v: Voice) {
    try {
      v.out.disconnect();
    } catch {
      /* ignore */
    }
  }

  // ─── store for React ────────────────────────────────────────────────────────────────

  subscribe(listener: () => void): () => void {
    this.bindPrefs();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Stable object until `unlocked` or `muted` changes (for useSyncExternalStore). */
  getSnapshot(): EngineSnapshot {
    const muted = this.isMuted();
    if (this.snapshot.unlocked !== this.unlocked || this.snapshot.muted !== muted) this.snapshot = { unlocked: this.unlocked, muted };
    return this.snapshot;
  }

  private emit() {
    this.getSnapshot();
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        /* ignore */
      }
    }
  }

}
