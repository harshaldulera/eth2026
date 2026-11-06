import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CUES, CUE_NAMES, recipeSpan, type CueName } from "./cues";
import { CLASS_META, ATTACK_CLASSES, moveToStamp } from "@/lib/scene/classes";
import { MAX_VOICES, SfxEngine } from "./engine";
import { sfx } from "./index";
import { FakeContext } from "./fake-audio.test-util";
import { __resetPrefsForTest } from "@/lib/pixel/prefs";

/** Every cue in the plan's table (§2.5). */
const PLAN_CUES = [
  "power_on", "ui_blip", "ui_confirm", "coin_pay", "recon_start", "send_ping", "packet_in",
  "class_authority", "class_override", "class_inject", "class_obfusc", "class_pressure", "class_escalate", "class_extract", "class_unknown",
  "think_tick", "type_tick", "stamp_hold", "stamp_flag", "alarm_lockdown", "breach_fanfare", "coins_out", "coins_sort",
  "freeze", "rank_up", "deploy", "radio_call", "approve", "deny", "wall_rotate",
];

describe("cue recipes", () => {
  it("implements every cue in the plan", () => {
    expect([...CUE_NAMES].sort()).toEqual([...PLAN_CUES].sort());
  });

  it.each(CUE_NAMES)("%s is a valid recipe", (name) => {
    const r = CUES[name];
    expect(["ui", "bed", "fx", "lead"]).toContain(r.bus);
    expect(r.tones.length).toBeGreaterThan(0);
    for (const t of r.tones) {
      expect(t.dur).toBeGreaterThan(0);
      expect(t.at ?? 0).toBeGreaterThanOrEqual(0);
      expect(t.gain ?? 0.2).toBeGreaterThan(0);
      expect(t.gain ?? 0.2).toBeLessThanOrEqual(0.6);
      if (t.wave !== "noise") {
        expect(t.freq).toBeGreaterThanOrEqual(20);
        expect(t.freq).toBeLessThanOrEqual(20000);
      }
      if (t.to !== undefined) expect(t.to).toBeGreaterThan(0);
      if (t.filter) expect(t.filter.freq).toBeGreaterThan(0);
      if (t.pan !== undefined) expect(Math.abs(t.pan)).toBeLessThanOrEqual(1);
      expect((t.attack ?? 0) + (t.release ?? 0)).toBeLessThanOrEqual(t.dur + 1);
    }
    // documented length matches what the tones actually span
    expect(recipeSpan(r)).toBeLessThanOrEqual(r.length + 1);
    expect(recipeSpan(r)).toBeGreaterThanOrEqual(r.length * 0.75);
    // peak loudness: simultaneous tones never sum past 1
    const edges = r.tones.map((t) => t.at ?? 0);
    for (const at of edges) {
      const sum = r.tones.filter((t) => (t.at ?? 0) <= at && (t.at ?? 0) + t.dur > at).reduce((s, t) => s + (t.gain ?? 0.2), 0);
      expect(sum).toBeLessThanOrEqual(1);
    }
  });

  it("the documented lengths from the plan", () => {
    const len = (n: CueName) => CUES[n].length;
    expect([len("power_on"), len("ui_blip"), len("ui_confirm"), len("coin_pay"), len("recon_start")]).toEqual([400, 60, 120, 350, 150]);
    expect([len("send_ping"), len("packet_in"), len("stamp_hold"), len("stamp_flag"), len("alarm_lockdown"), len("breach_fanfare")]).toEqual([80, 180, 120, 160, 900, 1200]);
    expect(CUES.coins_out.tones.filter((t) => t.freq && t.freq > 1300).length).toBe(12);
    expect(CUES.alarm_lockdown.duck).toBeGreaterThan(0);
    expect(CUES.breach_fanfare.duck).toBeGreaterThan(0);
    expect(CUES.type_tick.retriggerMs).toBeLessThanOrEqual(34);
  });

  it("every cue the scene names exists", () => {
    for (const c of ATTACK_CLASSES) expect(CUE_NAMES).toContain(CLASS_META[c].cue);
    for (const m of ["hold", "expose", "banish", "open"] as const) expect(CUE_NAMES).toContain(moveToStamp(m).cue);
  });
});

describe("engine", () => {
  let ctx: FakeContext;
  let now = 0;
  let quiet = false;
  const make = () => new SfxEngine({ createContext: () => ctx as unknown as AudioContext, now: () => now, quiet: () => quiet });
  const store = new Map<string, string>();

  beforeEach(() => {
    ctx = new FakeContext();
    now = 1000;
    quiet = false;
    store.clear();
    __resetPrefsForTest(() => ({ storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) }, root: null }));
  });
  afterEach(() => __resetPrefsForTest());

  it("play is a no-op before unlock", () => {
    const e = make();
    e.play("stamp_hold");
    expect(ctx.created.osc + ctx.created.gain).toBe(0);
    expect(e.activeVoices()).toBe(0);
  });

  it("unlock resumes the context; play then builds nodes on the right bus", async () => {
    const e = make();
    expect(await e.unlock()).toBe(true);
    expect(ctx.state).toBe("running");
    e.play("breach_fanfare");
    expect(ctx.created.osc).toBeGreaterThanOrEqual(8);
    expect(e.activeVoices()).toBe(1);
  });

  it("never exceeds 8 voices: the oldest is stolen", async () => {
    const e = make();
    await e.unlock();
    let max = 0;
    for (let i = 0; i < 40; i++) {
      e.play(CUE_NAMES[i % CUE_NAMES.length]);
      now += 200;
      max = Math.max(max, e.activeVoices());
    }
    expect(max).toBe(MAX_VOICES);
    // stolen voices were stopped
    expect(ctx.sources.filter((s) => s.stopped >= 0).length).toBe(ctx.sources.length);
  });

  it("voices free up once their time has passed", async () => {
    const e = make();
    await e.unlock();
    e.play("ui_confirm");
    expect(e.activeVoices()).toBe(1);
    ctx.currentTime += 1;
    expect(e.activeVoices()).toBe(0);
  });

  it("no retrigger within 150 ms (type_tick has its own 33 ms)", async () => {
    const e = make();
    await e.unlock();
    e.play("stamp_hold");
    now += 100;
    e.play("stamp_hold");
    expect(e.activeVoices()).toBe(1);
    now += 60;
    e.play("stamp_hold");
    expect(e.activeVoices()).toBe(2);
    e.play("type_tick");
    now += 34;
    e.play("type_tick");
    expect(e.activeVoices()).toBe(4);
  });

  it("mute persists under siege.sfx.muted and silences play", async () => {
    const e = make();
    await e.unlock();
    e.mute(true);
    expect(store.get("siege.sfx.muted")).toBe("1");
    expect(e.isMuted()).toBe(true);
    e.play("coin_pay");
    expect(e.activeVoices()).toBe(0);
    expect(e.toggleMute()).toBe(false);
    expect(store.get("siege.sfx.muted")).toBe("0");
    e.play("coin_pay");
    expect(e.activeVoices()).toBe(1);
  });

  it("a stored mute is honoured by a fresh engine", async () => {
    store.set("siege.sfx.muted", "1");
    __resetPrefsForTest(() => ({ storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) }, root: null }));
    const e = make();
    await e.unlock();
    e.play("deny");
    expect(e.activeVoices()).toBe(0);
    expect(e.getSnapshot()).toEqual({ unlocked: true, muted: true });
  });

  it("quiet profile: UI blips and ticks are silent, game cues still play", async () => {
    quiet = true;
    const e = make();
    await e.unlock();
    for (const n of ["ui_blip", "ui_confirm", "think_tick", "type_tick", "wall_rotate"]) e.play(n);
    expect(e.activeVoices()).toBe(0);
    e.play("stamp_flag");
    expect(e.activeVoices()).toBe(1);
  });

  it("never throws: broken context, unknown cue, server", async () => {
    const e = make();
    await e.unlock();
    ctx.failOsc = true;
    expect(() => e.play("approve")).not.toThrow();
    expect(() => e.play("no_such_cue")).not.toThrow();
    expect(() => sfx.play("stamp_hold")).not.toThrow(); // node: no window, never unlocked
    await expect(new SfxEngine({ createContext: () => null }).unlock()).resolves.toBe(false);
  });

  it("register: a clip replaces a cue once loaded; the synth plays until then", async () => {
    const fetchStub = (async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })) as unknown as typeof fetch;
    const e = new SfxEngine({ createContext: () => ctx as unknown as AudioContext, now: () => now, quiet: () => false, fetch: fetchStub });
    await e.unlock();
    e.register("coin_pay", { url: "/sfx/coin.ogg" });
    e.play("coin_pay");
    expect(ctx.created.osc).toBeGreaterThan(0); // synth fallback
    await new Promise((r) => setTimeout(r, 0));
    const before = ctx.created.buffer;
    now += 500;
    e.play("coin_pay");
    expect(ctx.created.buffer).toBe(before + 1);
    e.register("my_cue", { bus: "fx", length: 50, tones: [{ wave: "sine", dur: 50, freq: 440 }] });
    expect(e.list()).toContain("my_cue");
  });
});
