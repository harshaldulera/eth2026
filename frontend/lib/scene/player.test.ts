import { describe, expect, it } from "vitest";
import { toBeats } from "./beats";
import { IRON_LOCKDOWN_OP, STONE_HOLD_OP, WOODEN_BREAK_OP } from "./fixtures";
import { frame, initialPlayer, isWaiting, playerReducer, type PlayerState } from "./player";

const run = (s: PlayerState, beats: ReturnType<typeof toBeats>, ms: number, step = 16) => {
  for (let t = 0; t < ms; t += step) s = playerReducer(s, { type: "tick", dt: step, beats });
  return s;
};

describe("player — replay", () => {
  it("plays a wooden break to the end and stops: door open, breach pose, payout coins, frozen", () => {
    const beats = toBeats(WOODEN_BREAK_OP.siege, WOODEN_BREAK_OP.events, WOODEN_BREAK_OP.castle);
    let s = playerReducer(initialPlayer("replay", beats), { type: "play", beats });
    s = run(s, beats, 60_000);
    expect(s.playing).toBe(false);
    expect(s.index).toBe(beats.length - 1);
    const f = frame(beats, s);
    expect(f).toMatchObject({ guard: "breach", vault: "open", pipsUsed: 3, ended: true, status: "broken", freeze: 1 });
    expect(f.coins).toMatchObject({ kind: "payout", amount: "550000000", progress: 1 });
    expect(f.pipStamps).toEqual(["hold", "hold", "breach"]);
    expect(f.visibleMessages.filter((m) => m.role === "guard").map((m) => m.stamp?.word)).toEqual(["HOLD", "HOLD", "BREACH"]);
  });

  it("frames along the way: class effect on the packet, typewriter on the reply, stamp lands on the reply", () => {
    const beats = toBeats(IRON_LOCKDOWN_OP.siege, IRON_LOCKDOWN_OP.events, IRON_LOCKDOWN_OP.castle);
    const packet2 = beats.findIndex((b) => b.id === "t2:packet");
    let f = frame(beats, { index: packet2, elapsedInBeat: 100 });
    expect(f).toMatchObject({ activeClass: "authority", guard: "alert", pipsUsed: 1, pipPending: true, stamp: null, turn: 2 });
    const reply2 = beats.findIndex((b) => b.id === "t2:reply");
    f = frame(beats, { index: reply2, elapsedInBeat: beats[reply2].durationMs / 2 });
    const text = beats[reply2].data.text!;
    expect(f.typedChars).toBe(Math.floor(text.length / 2));
    expect(f.visibleMessages.at(-1)!.stamp).toBeUndefined();
    const stamp2 = reply2 + 1;
    f = frame(beats, { index: stamp2, elapsedInBeat: 0 });
    expect(f.stamp?.text).toBe("FLAGGED · AUTHORITY IMPERSONATION");
    expect(f.guard).toBe("flag");
    expect(f.visibleMessages.at(-1)!.stamp?.kind).toBe("flag");
    const lock = beats.findIndex((b) => b.id === "t3:stamp");
    f = frame(beats, { index: lock, elapsedInBeat: 0 });
    expect(f).toMatchObject({ guard: "lockdown", pipsUsed: 3, pipsLost: 2 });
  });

  it("scrubbing: step/stepTurn/seek land on finished beats while paused", () => {
    const beats = toBeats(STONE_HOLD_OP.siege, STONE_HOLD_OP.events, STONE_HOLD_OP.castle);
    let s = initialPlayer("replay", beats);
    s = playerReducer(s, { type: "stepTurn", delta: 1, beats });
    expect(beats[s.index].id).toBe("t1:packet");
    s = playerReducer(s, { type: "stepTurn", delta: 2, beats });
    expect(beats[s.index].id).toBe("t3:packet");
    s = playerReducer(s, { type: "step", delta: 2, beats });
    expect(beats[s.index].id).toBe("t3:reply");
    expect(frame(beats, s).typedChars).toBe(beats[s.index].data.text!.length);
    s = playerReducer(s, { type: "stepTurn", delta: -1, beats });
    expect(beats[s.index].id).toBe("t3:packet");
    s = playerReducer(s, { type: "seek", index: 999, beats });
    expect(s.index).toBe(beats.length - 1);
    s = playerReducer(s, { type: "speed", speed: 2 });
    expect(s.speed).toBe(2);
    // play from the end restarts
    s = playerReducer(s, { type: "play", beats });
    expect(s).toMatchObject({ index: 0, playing: true });
  });
});

describe("player — live", () => {
  it("starts on the newest beat already played, idles there, and plays beats as they arrive", () => {
    const op = IRON_LOCKDOWN_OP;
    const partial = { ...op.siege, status: "in_progress" as const, messages: op.siege.messages.filter((m) => m.turn === 1 || (m.turn === 2 && m.role === "raider")) };
    const early = toBeats(partial, op.events.filter((e) => e.turn === 1 || e.type === "start"), op.castle, { mode: "live" });
    expect(early.at(-1)).toMatchObject({ kind: "think", data: { pending: true } });
    let s = initialPlayer("live", early);
    expect(s.index).toBe(early.length - 1);
    s = run(s, early, 2000);
    expect(isWaiting(early, s)).toBe(true);
    expect(frame(early, s).guard).toBe("thinking");

    const full = toBeats(op.siege, op.events, op.castle, { mode: "live" });
    s = playerReducer(s, { type: "sync", beats: full });
    expect(isWaiting(full, s)).toBe(false);
    s = run(s, full, 1);
    expect(full[s.index].id).toBe("t2:reply");
    s = run(s, full, 60_000);
    expect(isWaiting(full, s)).toBe(true);
    expect(frame(full, s)).toMatchObject({ ended: true, status: "banished", pipsLost: 2 });
  });

  it("a big lag jumps to the start of the newest turn", () => {
    const op = STONE_HOLD_OP;
    const beats = toBeats(op.siege, op.events, op.castle, { mode: "live" });
    const s = playerReducer({ index: 0, elapsedInBeat: 0, playing: true, speed: 1, mode: "live" }, { type: "sync", beats });
    expect(beats[s.index].id).toBe("t5:packet");
  });
});
