import { describe, expect, it } from "vitest";
import { INTERRUPT_MS, SLIDE_MS, deckReducer, elapsed, initialDeck, nextKind, slideParam, type Availability, type DeckState } from "./deck";

const NONE: Availability = { liveId: null, breachId: null, pending: false };
const ALL: Availability = { liveId: "s_live", breachId: "s_br", pending: true };

const tick = (s: DeckState, now: number, avail: Availability = ALL) => deckReducer(s, { type: "tick", now, avail });

describe("wall deck rotation", () => {
  it("rotates LIVE → GRID → BREACH → SEASON → PAGER and wraps", () => {
    expect(nextKind("live", ALL)).toBe("grid");
    expect(nextKind("grid", ALL)).toBe("breach");
    expect(nextKind("breach", ALL)).toBe("season");
    expect(nextKind("season", ALL)).toBe("pager");
    expect(nextKind("pager", ALL)).toBe("live");
  });

  it("skips slides with nothing to show; GRID and SEASON always run", () => {
    expect(nextKind("grid", NONE)).toBe("season");
    expect(nextKind("season", NONE)).toBe("grid");
    expect(nextKind("season", { ...NONE, liveId: "x" })).toBe("live");
  });

  it("advances when the slide's time is up, carrying the op id", () => {
    let s = initialDeck(0, "grid");
    s = tick(s, SLIDE_MS.grid - 1);
    expect(s.slide.kind).toBe("grid");
    s = tick(s, SLIDE_MS.grid);
    expect(s.slide).toMatchObject({ kind: "breach", siegeId: "s_br", seq: 1 });
    s = tick(s, SLIDE_MS.grid + SLIDE_MS.breach);
    expect(s.slide.kind).toBe("season");
  });

  it("LIVE OP stays until the slide reports done, even after the op leaves /api/stats", () => {
    let s = initialDeck(0, "live");
    s = tick(s, 0, ALL); // picks up the op id
    expect(s.slide.siegeId).toBe("s_live");
    s = tick(s, 5_000, { ...ALL, liveId: null });
    expect(s.slide.kind).toBe("live");
    s = deckReducer(s, { type: "done", seq: s.slide.seq });
    s = tick(s, 6_000, { ...ALL, liveId: null });
    expect(s.slide.kind).toBe("grid");
  });

  it("LIVE OP is capped at 60 s", () => {
    let s = tick(initialDeck(0, "live"), 0);
    s = tick(s, SLIDE_MS.live);
    expect(s.slide.kind).toBe("grid");
  });

  it("ignores a late done from a previous slide", () => {
    let s = initialDeck(0, "grid");
    s = deckReducer(s, { type: "next", now: 1, avail: ALL });
    s = deckReducer(s, { type: "done", seq: 0 });
    expect(s.done).toBe(false);
  });

  it("PAGER MIRROR leaves as soon as nothing is pending", () => {
    let s = initialDeck(0, "pager");
    s = tick(s, 1_000, ALL);
    expect(s.slide.kind).toBe("pager");
    s = tick(s, 2_000, { ...ALL, pending: false });
    expect(s.slide.kind).toBe("live");
  });

  it("space pauses the clock and resumes where it was", () => {
    let s = initialDeck(0, "grid");
    s = deckReducer(s, { type: "toggle", now: 5_000 });
    s = tick(s, 60_000);
    expect(s.slide.kind).toBe("grid");
    expect(elapsed(s, 60_000)).toBe(5_000);
    s = deckReducer(s, { type: "toggle", now: 60_000 });
    expect(elapsed(s, 61_000)).toBe(6_000);
    s = tick(s, 60_000 + SLIDE_MS.grid - 5_000);
    expect(s.slide.kind).toBe("breach");
  });

  it("n skips to the next slide", () => {
    const s = deckReducer(initialDeck(0, "season"), { type: "next", now: 10, avail: NONE });
    expect(s.slide.kind).toBe("grid");
    expect(s.startedAt).toBe(10);
  });

  it("a breach preempts for 25 s, then the rotation resumes after LIVE OP", () => {
    let s = initialDeck(0, "season");
    s = deckReducer(s, { type: "interrupt", kind: "breach", siegeId: "s_x", now: 1_000 });
    expect(s.slide).toMatchObject({ kind: "op", siegeId: "s_x", interrupt: "breach" });
    expect(s.maxMs).toBe(INTERRUPT_MS.breach);
    s = deckReducer(s, { type: "done", seq: s.slide.seq }); // ignored timing-wise: op slides hold
    s = tick(s, 1_000 + INTERRUPT_MS.breach, ALL);
    expect(s.slide.kind).toBe("grid");
  });

  it("a lockdown holds 8 s and never cuts into a breach on screen", () => {
    let s = deckReducer(initialDeck(0, "grid"), { type: "interrupt", kind: "lockdown", siegeId: "s_l", now: 0 });
    expect(s.maxMs).toBe(INTERRUPT_MS.lockdown);
    s = deckReducer(s, { type: "interrupt", kind: "breach", siegeId: "s_b", now: 1_000 });
    expect(s.slide).toMatchObject({ siegeId: "s_b", interrupt: "breach" });
    const same = deckReducer(s, { type: "interrupt", kind: "lockdown", siegeId: "s_l2", now: 2_000 });
    expect(same).toBe(s);
  });

  it("an interrupt for the op already on the LIVE slide extends it instead of switching", () => {
    let s = tick(initialDeck(0, "live"), 0);
    s = deckReducer(s, { type: "done", seq: s.slide.seq });
    s = deckReducer(s, { type: "interrupt", kind: "breach", siegeId: "s_live", now: 50_000 });
    expect(s.slide).toMatchObject({ kind: "live", siegeId: "s_live", interrupt: "breach" });
    expect(s.done).toBe(false);
    expect(s.maxMs - elapsed(s, 50_000)).toBe(INTERRUPT_MS.breach);
    s = tick(s, 50_000 + INTERRUPT_MS.breach - 1, { ...ALL, liveId: null });
    expect(s.slide.kind).toBe("live");
  });

  it("nothing cuts in while paused", () => {
    const p = deckReducer(initialDeck(0, "grid"), { type: "toggle", now: 0 });
    expect(deckReducer(p, { type: "interrupt", kind: "breach", siegeId: "s", now: 1 })).toBe(p);
  });

  it("a deck made during render starts its clock on the first tick", () => {
    let s = initialDeck(-1, "grid");
    expect(elapsed(s, 99)).toBe(0);
    s = tick(s, 1_000);
    expect(s.startedAt).toBe(1_000);
    expect(tick(s, 1_000 + SLIDE_MS.grid).slide.kind).toBe("breach");
  });

  it("a paused ?slide=breach still picks its op up", () => {
    let s = initialDeck(-1, "breach", true);
    s = tick(s, 0, NONE);
    s = tick(s, 1_000, ALL);
    expect(s.slide.siegeId).toBe("s_br");
    expect(s.paused).toBe(true);
  });

  it("waits for the first stats answer before calling a slide empty", () => {
    let s = initialDeck(-1, "live");
    s = tick(s, 0, { ...NONE, ready: false });
    s = tick(s, 500, { ...NONE, ready: false });
    expect(s.slide.kind).toBe("live");
    s = tick(s, 900, { ...ALL, ready: true });
    expect(s.slide).toMatchObject({ kind: "live", siegeId: "s_live" });
  });

  it("parses ?slide=", () => {
    expect(slideParam("season")).toBe("season");
    expect(slideParam("op")).toBeNull();
    expect(slideParam(null)).toBeNull();
  });
});
