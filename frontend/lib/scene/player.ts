import { MAX_TURNS, type Amount, type FeeSplit, type SiegeStatus, type ToolCall, type TxRef } from "@/lib/types";
import type { AttackClass, Stamp, StampKind } from "./classes";
import { turnStart, type Beat } from "./beats";

/**
 * The scene player (plan §2.6): a reducer over `{index, elapsedInBeat, playing, speed, mode}` and a
 * pure `frame()` that says what the stage shows at that instant. Live mode follows the newest beat
 * and idles on a pending beat; replay mode is driven by the scrubber.
 */

export type PlayerMode = "live" | "replay";

export type PlayerState = { index: number; elapsedInBeat: number; playing: boolean; speed: number; mode: PlayerMode };

export type PlayerAction =
  | { type: "tick"; dt: number; beats: readonly Beat[] }
  | { type: "sync"; beats: readonly Beat[] }
  | { type: "play"; beats?: readonly Beat[] }
  | { type: "pause" }
  | { type: "toggle"; beats?: readonly Beat[] }
  | { type: "seek"; index: number; beats: readonly Beat[] }
  | { type: "step"; delta: number; beats: readonly Beat[] }
  | { type: "stepTurn"; delta: number; beats: readonly Beat[] }
  | { type: "speed"; speed: number }
  | { type: "reset"; mode: PlayerMode; beats: readonly Beat[] };

export const SPEEDS = [0.5, 1, 2] as const;
/** Live: when the newest turn is more than this many turns ahead, jump to its start. */
export const LIVE_MAX_TURN_LAG = 1;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dur = (b: Beat | undefined) => Math.max(1, b?.durationMs ?? 1);

/** Live mode starts on the newest beat, already finished (no replaying history on page load). */
export function initialPlayer(mode: PlayerMode, beats: readonly Beat[]): PlayerState {
  if (mode === "replay" || beats.length === 0) return { index: 0, elapsedInBeat: 0, playing: mode === "live", speed: 1, mode };
  const index = beats.length - 1;
  const last = beats[index];
  return { index, elapsedInBeat: last.data.pending ? 0 : dur(last), playing: true, speed: 1, mode };
}

/** Nothing left to animate: at the last beat and it is finished, or the current beat is pending. */
export function isWaiting(beats: readonly Beat[], s: PlayerState): boolean {
  const b = beats[s.index];
  if (!b) return true;
  if (b.data.pending) return s.elapsedInBeat >= dur(b);
  return s.index >= beats.length - 1 && s.elapsedInBeat >= dur(b);
}

function advance(s: PlayerState, beats: readonly Beat[], dt: number): PlayerState {
  if (!beats.length) return s;
  let index = clamp(s.index, 0, beats.length - 1);
  let elapsed = s.elapsedInBeat + dt * s.speed;
  for (;;) {
    const b = beats[index];
    const d = dur(b);
    if (elapsed < d) break;
    if (b.data.pending || index >= beats.length - 1) {
      elapsed = d;
      break;
    }
    elapsed -= d;
    index++;
  }
  let playing = s.playing;
  if (s.mode === "replay" && index >= beats.length - 1 && elapsed >= dur(beats[index]) && !beats[index].data.pending) playing = false;
  if (index === s.index && elapsed === s.elapsedInBeat && playing === s.playing) return s;
  return { ...s, index, elapsedInBeat: elapsed, playing };
}

/** Where a seek lands: at the beat's start while playing, at its end (fully shown) while paused. */
function seekTo(s: PlayerState, beats: readonly Beat[], index: number): PlayerState {
  if (!beats.length) return s;
  const i = clamp(index, 0, beats.length - 1);
  return { ...s, index: i, elapsedInBeat: s.playing ? 0 : dur(beats[i]) };
}

export function playerReducer(s: PlayerState, a: PlayerAction): PlayerState {
  switch (a.type) {
    case "tick":
      if (!s.playing || a.dt <= 0) return s;
      return advance(s, a.beats, a.dt);
    case "sync": {
      const beats = a.beats;
      if (!beats.length) return s.index === 0 && s.elapsedInBeat === 0 ? s : { ...s, index: 0, elapsedInBeat: 0 };
      if (s.index > beats.length - 1) return { ...s, index: beats.length - 1, elapsedInBeat: 0 };
      if (s.mode === "live") {
        // More than a turn behind (tab was hidden, slow poll): skip to the newest turn's start.
        const newest = beats[beats.length - 1].turn;
        if (newest > (beats[s.index]?.turn ?? 0) + LIVE_MAX_TURN_LAG) {
          const start = turnStart(beats, newest);
          const index = start > s.index ? start : beats.length - 1;
          return { ...s, index, elapsedInBeat: 0, playing: true };
        }
        if (!s.playing) return { ...s, playing: true };
      }
      return s;
    }
    case "play": {
      if (s.playing) return s;
      // replay finished: play again from the top
      if (s.mode === "replay" && a.beats && s.index >= a.beats.length - 1 && s.elapsedInBeat >= dur(a.beats[s.index])) {
        return { ...s, playing: true, index: 0, elapsedInBeat: 0 };
      }
      return { ...s, playing: true };
    }
    case "pause":
      return s.playing ? { ...s, playing: false } : s;
    case "toggle":
      return s.playing ? { ...s, playing: false } : playerReducer(s, { type: "play", beats: a.beats });
    case "seek":
      return seekTo(s, a.beats, a.index);
    case "step":
      return seekTo(s, a.beats, s.index + a.delta);
    case "stepTurn": {
      const beats = a.beats;
      const cur = beats[s.index]?.turn ?? 0;
      const maxTurn = beats.reduce((m, b) => Math.max(m, b.turn), 0);
      let target = cur + a.delta;
      // stepping back from the middle of a turn goes to that turn's start first
      if (a.delta < 0 && turnStart(beats, cur) >= 0 && turnStart(beats, cur) < s.index) target = cur;
      if (target <= 0) return seekTo(s, beats, 0);
      if (target > maxTurn) return seekTo(s, beats, beats.length - 1);
      const i = turnStart(beats, target);
      return i >= 0 ? seekTo(s, beats, i) : s;
    }
    case "speed":
      return s.speed === a.speed ? s : { ...s, speed: clamp(a.speed, 0.25, 4) };
    case "reset":
      return initialPlayer(a.mode, a.beats);
  }
}

// ─── frame ────────────────────────────────────────────────────────────────────────────────

export type GuardPose = "idle" | "alert" | "thinking" | "hold" | "flag" | "lockdown" | "breach";
export type VaultPose = "closed" | "shaking" | "open";

export type SceneMessage = {
  id: string;
  turn: number;
  role: "operator" | "guard";
  text: string;
  /** Characters revealed so far (equals text.length once typed). */
  typed: number;
  cls?: AttackClass;
  label?: string;
  clsSource?: "client" | "referee";
  threat?: number;
  /** Guard lines: the verdict (attached when the stamp has landed). */
  stamp?: Stamp;
  requestId?: string;
  toolCalls?: ToolCall[];
  exposed?: string;
};

export type SceneCoins =
  | { kind: "none" }
  | { kind: "split"; progress: number; split?: FeeSplit; newPot?: Amount; tx?: TxRef; pending: boolean }
  | { kind: "payout"; progress: number; amount?: Amount; tx?: TxRef; raider?: string; pending: boolean };

export type SceneFrame = {
  guard: GuardPose;
  vault: VaultPose;
  /** Turns resolved (pips burnt). */
  pipsUsed: number;
  threat: number;
  /** Class effect playing right now (packet beat only). */
  activeClass: AttackClass | null;
  /** The current turn's verdict, once stamped (cleared by the next packet). */
  stamp: Stamp | null;
  visibleMessages: SceneMessage[];
  /** Characters revealed of the guard line being typed (the last guard message). */
  typedChars: number;
  coins: SceneCoins;
  // ── additive ──
  beat: Beat | null;
  beatIndex: number;
  /** 0–1 inside the current beat. */
  progress: number;
  turn: number;
  /** Stamp kind per resolved turn, for the pips. */
  pipStamps: StampKind[];
  /** A sent message is waiting for its verdict (pip N blinks). */
  pipPending: boolean;
  /** Pips a LOCKDOWN crossed out ("2 LOST"). */
  pipsLost: number;
  /** The current beat waits on the server. */
  pending: boolean;
  /** Class segments filled per class this op (escalation bar). */
  classCounts: Partial<Record<AttackClass, number>>;
  ended: boolean;
  status?: SiegeStatus;
  /** The op was voided (vault closed / guard offline under it); `status` may still read in_progress. */
  voided: boolean;
  free: boolean;
  /** 0–1 desaturation for the freeze (end beat). */
  freeze: number;
  transcriptHash?: string;
};

const POSE: Record<StampKind, GuardPose> = { hold: "hold", flag: "flag", lockdown: "lockdown", breach: "breach" };

export const EMPTY_FRAME: SceneFrame = Object.freeze({
  guard: "idle",
  vault: "closed",
  pipsUsed: 0,
  threat: 0,
  activeClass: null,
  stamp: null,
  visibleMessages: [],
  typedChars: 0,
  coins: { kind: "none" },
  beat: null,
  beatIndex: -1,
  progress: 0,
  turn: 0,
  pipStamps: [],
  pipPending: false,
  pipsLost: 0,
  pending: false,
  classCounts: {},
  ended: false,
  voided: false,
  free: false,
  freeze: 0,
}) as SceneFrame;

/** What the stage shows at `state` (pure). */
export function frame(beats: readonly Beat[], state: Pick<PlayerState, "index" | "elapsedInBeat">): SceneFrame {
  if (!beats.length) return EMPTY_FRAME;
  const index = clamp(state.index, 0, beats.length - 1);
  const f: SceneFrame = { ...EMPTY_FRAME, visibleMessages: [], pipStamps: [], classCounts: {}, beatIndex: index };
  let turnStamp: Stamp | null = null;

  for (let i = 0; i <= index; i++) {
    const b = beats[i];
    const current = i === index;
    const p = current ? clamp(state.elapsedInBeat / dur(b), 0, 1) : 1;
    const d = b.data;
    switch (b.kind) {
      case "intro":
        f.guard = "idle";
        break;
      case "packet": {
        f.turn = b.turn;
        f.stamp = null;
        turnStamp = null;
        if (d.threat !== undefined) f.threat = d.threat;
        f.activeClass = current ? (d.cls ?? "unclassified") : null;
        if (d.cls) f.classCounts[d.cls] = (f.classCounts[d.cls] ?? 0) + 1;
        f.guard = "alert";
        f.pipPending = true;
        if (f.vault !== "open") f.vault = current && (d.threat ?? 0) >= 70 ? "shaking" : "closed";
        f.visibleMessages.push({ id: b.id, turn: b.turn, role: "operator", text: d.text ?? "", typed: (d.text ?? "").length, cls: d.cls, label: d.label, clsSource: d.clsSource, threat: d.threat, requestId: d.requestId });
        break;
      }
      case "think":
        f.guard = "thinking";
        f.activeClass = null;
        if (f.vault !== "open") f.vault = current && (d.threat ?? 0) >= 85 ? "shaking" : "closed";
        break;
      case "reply": {
        const text = d.text ?? "";
        const typed = d.instant ? text.length : current ? Math.floor(p * text.length) : text.length;
        f.typedChars = typed;
        f.activeClass = null;
        if (!turnStamp) f.guard = "idle";
        f.visibleMessages.push({ id: b.id, turn: b.turn, role: "guard", text, typed, stamp: turnStamp ?? undefined, requestId: d.requestId, toolCalls: d.toolCalls, exposed: d.exposed });
        break;
      }
      case "stamp": {
        const s = d.stamp ?? null;
        turnStamp = s;
        f.stamp = s;
        f.activeClass = null;
        f.pipsUsed = b.turn;
        f.pipPending = false;
        if (s) {
          f.pipStamps.push(s.kind);
          f.guard = POSE[s.kind];
          if (s.kind === "breach") f.vault = current && p < 0.25 ? "shaking" : "open";
          else if (f.vault !== "open") f.vault = "closed";
          if (s.kind === "lockdown") f.pipsLost = Math.max(0, MAX_TURNS - b.turn);
          // stamp lands on the reply it judges
          for (let m = f.visibleMessages.length - 1; m >= 0; m--) {
            const msg = f.visibleMessages[m];
            if (msg.turn !== b.turn) break;
            if (msg.role === "guard") {
              f.visibleMessages[m] = { ...msg, stamp: s };
              break;
            }
          }
        }
        break;
      }
      case "settle":
        f.status = d.status;
        f.free = Boolean(d.free);
        f.coins = d.free || d.reason ? { kind: "none" } : { kind: "split", progress: d.pending ? 0 : p, split: d.split, newPot: d.newPot, tx: d.tx, pending: Boolean(d.pending) };
        break;
      case "payout":
        f.status = d.status;
        f.free = Boolean(d.free);
        f.coins = d.free || d.reason ? { kind: "none" } : { kind: "payout", progress: d.pending ? 0 : p, amount: d.amount, tx: d.tx, raider: d.raider, pending: Boolean(d.pending) };
        break;
      case "void":
        f.voided = true;
        f.status = d.status;
        f.free = Boolean(d.free);
        f.coins = { kind: "none" };
        break;
      case "end":
        f.ended = true;
        f.status = d.status;
        f.free = Boolean(d.free);
        f.freeze = p;
        f.transcriptHash = d.transcriptHash;
        break;
    }
    if (current) {
      f.beat = b;
      f.progress = p;
      f.pending = Boolean(d.pending);
    }
  }
  return f;
}
