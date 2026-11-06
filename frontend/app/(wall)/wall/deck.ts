/**
 * The spectator wall's slide deck (design §3.8), as a pure reducer so the rotation rules are tested
 * without a browser. One timer drives everything: the wall view ticks it with the current time.
 *
 * Rotation: LIVE OP → THE GRID → LAST BREACH → SEASON → PAGER MIRROR, skipping slides with nothing
 * to show. A breach in the global feed preempts for 25 s, a lockdown for 8 s; if the LIVE OP slide
 * is already showing that op, it just stays up longer. Space pauses (the clock stops), `n` skips.
 */

export type SlideKind = "live" | "grid" | "breach" | "season" | "pager" | "op";
export type InterruptKind = "breach" | "lockdown";

export const ROTATION: readonly Exclude<SlideKind, "op">[] = ["live", "grid", "breach", "season", "pager"];

export const SLIDE_MS: Readonly<Record<SlideKind, number>> = {
  live: 60_000, // "until end, max 60 s"
  grid: 20_000,
  breach: 15_000,
  season: 15_000,
  pager: 30_000, // "while pending, max 30 s"
  op: 25_000,
};

export const INTERRUPT_MS: Readonly<Record<InterruptKind, number>> = { breach: 25_000, lockdown: 8_000 };

export const SLIDE_TITLE: Readonly<Record<SlideKind, string>> = {
  live: "LIVE OP",
  grid: "THE GRID",
  breach: "LAST BREACH",
  season: "SEASON",
  pager: "PAGER",
  op: "LIVE OP",
};

/** What can be shown right now (from /api/stats and the pending approvals). */
export type Availability = {
  liveId: string | null;
  breachId: string | null;
  pending: boolean;
  /** False until the first /api/stats answer: nothing counts as "gone" before we know. */
  ready?: boolean;
};

export type Slide = {
  kind: SlideKind;
  /** The op on screen (live / breach / op slides). */
  siegeId?: string;
  /** Set when this slide (or its extension) came from a feed event. */
  interrupt?: InterruptKind;
  /** Bumps on every entry, so the power-on wipe replays even for the same kind. */
  seq: number;
};

export type DeckState = {
  slide: Slide;
  /** Wall-clock ms when the slide's clock started (shifted forward while paused). */
  startedAt: number;
  /** How long this slide may stay up. */
  maxMs: number;
  paused: boolean;
  pausedAt: number | null;
  /** The slide asked to leave (live op ended, nothing pending any more). */
  done: boolean;
};

export type DeckAction =
  | { type: "tick"; now: number; avail: Availability }
  | { type: "next"; now: number; avail: Availability }
  | { type: "toggle"; now: number }
  | { type: "done"; seq: number }
  | { type: "interrupt"; kind: InterruptKind; siegeId: string; now: number };

/** Is this rotation slide worth showing right now? THE GRID and SEASON always are. */
export function available(kind: SlideKind, a: Availability): boolean {
  switch (kind) {
    case "live":
      return Boolean(a.liveId);
    case "breach":
      return Boolean(a.breachId);
    case "pager":
      return a.pending;
    case "op":
      return false;
    default:
      return true;
  }
}

/** The slide after `kind` in the rotation (an interrupt resumes after LIVE OP). */
export function nextKind(kind: SlideKind, a: Availability): Exclude<SlideKind, "op"> {
  const from = kind === "op" ? ROTATION.indexOf("live") : ROTATION.indexOf(kind);
  for (let i = 1; i <= ROTATION.length; i++) {
    const k = ROTATION[(from + i) % ROTATION.length];
    if (available(k, a)) return k;
  }
  return "grid";
}

function enter(kind: Exclude<SlideKind, "op">, prev: DeckState, now: number, a: Availability): DeckState {
  const siegeId = kind === "live" ? (a.liveId ?? undefined) : kind === "breach" ? (a.breachId ?? undefined) : undefined;
  return { slide: { kind, siegeId, seq: prev.slide.seq + 1 }, startedAt: now, maxMs: SLIDE_MS[kind], paused: prev.paused, pausedAt: prev.paused ? now : null, done: false };
}

/** Parse `?slide=` (start on a given slide; handy for the presenter and the screenshot matrix). */
export function slideParam(v: string | null | undefined): Exclude<SlideKind, "op"> | null {
  return v && (ROTATION as readonly string[]).includes(v) ? (v as Exclude<SlideKind, "op">) : null;
}

/** `now` < 0: the clock starts on the first tick. */
export function initialDeck(now: number, first: Exclude<SlideKind, "op"> = "grid", paused = false): DeckState {
  return { slide: { kind: first, seq: 0 }, startedAt: now, maxMs: SLIDE_MS[first], paused, pausedAt: paused ? now : null, done: false };
}

/** Time the current slide has been up (frozen while paused). */
export function elapsed(s: DeckState, now: number): number {
  if (s.startedAt < 0) return 0;
  return Math.max(0, (s.paused && s.pausedAt != null ? s.pausedAt : now) - s.startedAt);
}

export function deckReducer(s: DeckState, a: DeckAction): DeckState {
  switch (a.type) {
    case "tick": {
      // First tick starts the clock (the deck is created during render, where there is no "now").
      if (s.startedAt < 0) return { ...s, startedAt: a.now, pausedAt: s.paused ? a.now : null };
      const k = s.slide.kind;
      // A LIVE OP / LAST BREACH slide that started before /api/stats answered picks its op up now
      // (paused or not: a paused wall still shows something).
      const want = k === "live" ? a.avail.liveId : k === "breach" ? a.avail.breachId : null;
      if (want && !s.slide.siegeId) return { ...s, slide: { ...s.slide, siegeId: want } };
      if (s.paused) return s;
      // Approvals decided: the pager mirror leaves at once. A LIVE OP slide that has its op stays
      // until the op's ending has played (the slide reports `done`), even after /api/stats drops it.
      const gone = a.avail.ready !== false && ((k === "pager" && !a.avail.pending) || ((k === "live" || k === "breach") && !s.slide.siegeId && !want));
      if (s.done || gone || a.now - s.startedAt >= s.maxMs) return enter(nextKind(k, a.avail), s, a.now, a.avail);
      return s;
    }
    case "next":
      return enter(nextKind(s.slide.kind, a.avail), s, a.now, a.avail);
    case "toggle":
      if (s.paused) return { ...s, paused: false, pausedAt: null, startedAt: s.startedAt + (a.now - (s.pausedAt ?? a.now)) };
      return { ...s, paused: true, pausedAt: a.now };
    case "done":
      // Only the slide that asked; a late callback from the previous slide is ignored.
      return a.seq === s.slide.seq && !s.done ? { ...s, done: true } : s;
    case "interrupt": {
      // Paused means the presenter is talking over this slide: nothing cuts in.
      if (s.paused) return s;
      const hold = INTERRUPT_MS[a.kind];
      const k = s.slide.kind;
      // Already on this op: stay up at least `hold` from now (a breach also outranks a lockdown hold).
      if ((k === "live" || k === "op") && s.slide.siegeId === a.siegeId) {
        const left = s.maxMs - elapsed(s, a.now);
        const interrupt = s.slide.interrupt === "breach" ? "breach" : a.kind;
        return { ...s, slide: { ...s.slide, interrupt }, maxMs: left >= hold ? s.maxMs : s.maxMs + (hold - left), done: false };
      }
      // A lockdown never cuts into a breach that is still on screen.
      if (k === "op" && s.slide.interrupt === "breach" && a.kind === "lockdown") return s;
      return {
        slide: { kind: "op", siegeId: a.siegeId, interrupt: a.kind, seq: s.slide.seq + 1 },
        startedAt: a.now,
        maxMs: hold,
        paused: s.paused,
        pausedAt: s.paused ? a.now : null,
        done: false,
      };
    }
  }
}
