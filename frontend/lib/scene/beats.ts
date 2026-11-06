import type { Amount, Castle, FeeSplit, GuardianMove, Siege, SiegeEvent, SiegeStatus, StoredSiegeEvent, ToolCall, TxRef } from "@/lib/types";
import { parseAttempt, parseRelease } from "@/lib/money/events";
import { classFor, moveToStamp, type AttackClass, type Stamp } from "./classes";
import { classifyText, classifyTurn } from "./classify";

/**
 * Siege + event feed → the beats the Op room and the replay play (plan §2.6). Pure.
 *
 * Per turn: packet (operator line + class + threat) → think → reply → stamp, except LOCKDOWN and
 * BREACH, which stamp before the reply. After the end: settle (fee split), payout (release) or void,
 * then `end` (the freeze). A turn whose reply has not arrived ends the list with a pending `think`.
 *
 * Live callers may append an optimistic raider message to `siege.messages` (and a synthetic
 * `message` event built from the send response's `referee`) to start the packet before the poll.
 */

export type BeatKind = "intro" | "packet" | "think" | "reply" | "stamp" | "settle" | "payout" | "void" | "end";

export type BeatData = {
  text?: string;
  cls?: AttackClass;
  /** Referee label (printed under the class). */
  label?: string;
  /** Who picked the class: the referee label or the client classifier. */
  clsSource?: "client" | "referee";
  /** Threat 0–100 (watchers only). */
  threat?: number;
  move?: GuardianMove;
  stamp?: Stamp;
  exposed?: string;
  requestId?: string;
  toolCalls?: ToolCall[];
  split?: FeeSplit;
  newPot?: Amount;
  streak?: number;
  amount?: Amount;
  raider?: string;
  tx?: TxRef;
  status?: SiegeStatus;
  free?: boolean;
  transcriptHash?: string;
  /** Live: waiting for the reply / the settlement event. The player idles on a pending beat. */
  pending?: boolean;
  /** Settlement failed / void reason. */
  reason?: string;
  /** Reduced motion: show the whole reply at once. */
  instant?: boolean;
};

export type Beat = { id: string; kind: BeatKind; turn: number; durationMs: number; data: BeatData };

export type BeatOptions = { mode?: "live" | "replay"; reducedMotion?: boolean };

export const BEAT_MS = Object.freeze({
  intro: 800,
  packet: 900,
  /** Replay think; live think is open-ended with this floor. */
  think: 700,
  thinkFloor: 900,
  replyPerChar: 25,
  replyMax: 2500,
  replyMin: 300,
  stamp: 600,
  settle: 1500,
  payout: 2500,
  void: 1500,
  end: 600,
});

/** Reduced motion: no flights, 300 ms icon pulse for the class, instant type-out; stamps still land. */
export const BEAT_MS_REDUCED = Object.freeze({
  intro: 300,
  packet: 300,
  think: 300,
  thinkFloor: 600,
  reply: 500,
  stamp: 600,
  settle: 800,
  payout: 1000,
  void: 800,
  end: 300,
});

export function replyMs(chars: number, reducedMotion = false): number {
  if (reducedMotion) return BEAT_MS_REDUCED.reply;
  return Math.max(BEAT_MS.replyMin, Math.min(BEAT_MS.replyMax, BEAT_MS.replyPerChar * Math.max(0, chars)));
}

type SceneCastle = Pick<Castle, "tier"> & Partial<Pick<Castle, "transport" | "guardianName" | "protectedTool" | "name" | "streak">>;
type SceneSiege = Pick<Siege, "id" | "messages" | "status"> & Partial<Pick<Siege, "transport" | "free" | "settlement" | "transcriptHash" | "turn">>;

const ENDED = new Set<SiegeStatus>(["held", "broken", "banished"]);

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const isMove = (v: unknown): v is GuardianMove => v === "hold" || v === "open" || v === "expose" || v === "banish";

function toolCallsOf(v: unknown): ToolCall[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const calls = v.filter((c): c is ToolCall => !!c && typeof c === "object" && typeof (c as ToolCall).name === "string");
  return calls.length ? calls.map((c) => ({ name: c.name, args: (c.args ?? {}) as Record<string, unknown> })) : undefined;
}

export function toBeats(siege: SceneSiege, events: readonly (StoredSiegeEvent | SiegeEvent)[], castle: SceneCastle, opts: BeatOptions = {}): Beat[] {
  const live = opts.mode === "live";
  const rm = Boolean(opts.reducedMotion);
  const D = rm ? BEAT_MS_REDUCED : BEAT_MS;
  const evs = events.filter((e) => !e.siegeId || e.siegeId === siege.id);
  const byTurn = (type: SiegeEvent["type"], turn: number) => {
    let hit: (typeof evs)[number] | undefined;
    for (const e of evs) if (e.type === type && e.turn === turn) hit = e; // latest wins
    return hit;
  };
  const latest = (type: SiegeEvent["type"]) => {
    for (let i = evs.length - 1; i >= 0; i--) if (evs[i].type === type) return evs[i];
    return undefined;
  };
  const transport = siege.transport ?? castle.transport ?? evs.find((e) => e.transport)?.transport;

  const beats: Beat[] = [
    { id: "intro", kind: "intro", turn: 0, durationMs: D.intro, data: { text: castle.guardianName, streak: castle.streak } },
  ];

  let turns = 0;
  for (const m of siege.messages) turns = Math.max(turns, m.turn);
  for (const e of evs) if ((e.type === "message" || e.type === "decision") && e.turn) turns = Math.max(turns, e.turn);

  // Voided mid-op (owner close, dormant guard): the siege can stay "in_progress" with a void
  // settlement. That is terminal too: the turn in flight never gets a reply.
  const voided = siege.settlement?.state === "void";
  let open = false; // a turn still waiting for its reply
  for (let t = 1; t <= turns; t++) {
    const raiderMsg = siege.messages.find((m) => m.role === "raider" && m.turn === t);
    const guardMsg = siege.messages.find((m) => m.role === "guardian" && m.turn === t);
    const mEv = byTurn("message", t);
    const dEv = byTurn("decision", t);
    const text = raiderMsg?.text ?? str(mEv?.payload.text);
    if (text === undefined) continue;

    const tactic = str(mEv?.payload.tactic);
    const pressure = num(mEv?.payload.pressure);
    const c = tactic ? { ...classifyTurn(text, tactic), threat: pressure } : classifyText(text, castle.tier, t);
    const threat = pressure ?? c.threat;
    const packetReq = str(mEv?.payload.requestId) ?? mEv?.requestId;
    beats.push({
      id: `t${t}:packet`,
      kind: "packet",
      turn: t,
      durationMs: D.packet,
      data: { text, cls: c.cls, label: c.label, clsSource: c.source, threat, requestId: packetReq },
    });

    const reply = guardMsg?.text ?? str(dEv?.payload.reply);
    const moveRaw = guardMsg?.move ?? dEv?.payload.move;
    if (reply === undefined || !isMove(moveRaw)) {
      if (voided) break; // the op ended under this message: no think beat to idle on
      beats.push({ id: `t${t}:think`, kind: "think", turn: t, durationMs: live ? D.thinkFloor : D.think, data: { pending: true, cls: c.cls, threat } });
      open = true;
      break;
    }
    beats.push({ id: `t${t}:think`, kind: "think", turn: t, durationMs: live ? D.thinkFloor : D.think, data: { cls: c.cls, threat } });

    const exposed = str(dEv?.payload.exposed) ?? undefined;
    const requestId = guardMsg?.requestId ?? str(dEv?.payload.requestId) ?? dEv?.requestId;
    // A FLAG names what the guard spotted when that maps to a class; otherwise the turn's class.
    // When the client detector picked the class (injection / obfuscation), the chip and the stage
    // effect already named it, so the stamp names the same attack (principle 3: stamps alone tell it).
    const flagCls =
      moveRaw === "expose" && c.source !== "client" && exposed && classFor(exposed) !== "unclassified" ? classFor(exposed) : c.cls;
    const stamp = moveToStamp(moveRaw, { transport, cls: flagCls, label: c.label });
    const replyBeat: Beat = {
      id: `t${t}:reply`,
      kind: "reply",
      turn: t,
      durationMs: replyMs(reply.length, rm),
      data: { text: reply, move: moveRaw, stamp, exposed, requestId, toolCalls: toolCallsOf(dEv?.payload.toolCalls), instant: rm || undefined },
    };
    const stampBeat: Beat = { id: `t${t}:stamp`, kind: "stamp", turn: t, durationMs: D.stamp, data: { move: moveRaw, stamp, cls: stamp.cls, threat, requestId } };
    if (stamp.before) beats.push(stampBeat, replyBeat);
    else beats.push(replyBeat, stampBeat);
  }

  const endEv = latest("end");
  const status = (str(endEv?.payload.status) as SiegeStatus | undefined) ?? (ENDED.has(siege.status) ? siege.status : voided ? siege.status : undefined);
  if (!voided && (open || !status || !ENDED.has(status))) return beats;

  const lastTurn = turns;
  const free = Boolean(siege.free ?? endEv?.payload.free);
  const settlement = siege.settlement;
  const failed = settlement?.state === "failed" ? settlement.reason ?? "settlement failed" : undefined;
  if (settlement?.state === "void") {
    beats.push({ id: "void", kind: "void", turn: lastTurn, durationMs: D.void, data: { status, reason: settlement.reason, free } });
  } else if (status === "broken") {
    const rEv = latest("release");
    const r = parseRelease(rEv?.payload);
    const pending = !rEv && !failed;
    beats.push({
      id: "payout",
      kind: "payout",
      turn: lastTurn,
      durationMs: D.payout,
      data: { status, amount: r.amount, raider: r.raider, tx: r.tx, free: free || rEv?.payload.free === true, pending: pending || undefined, reason: failed },
    });
    if (pending) return beats;
  } else {
    const aEv = latest("attempt");
    const a = parseAttempt(aEv?.payload);
    const pending = !aEv && !failed;
    beats.push({
      id: "settle",
      kind: "settle",
      turn: lastTurn,
      durationMs: D.settle,
      data: { status, split: a.split, newPot: a.newPot, tx: a.tx, streak: a.streak, free: free || aEv?.payload.free === true, pending: pending || undefined, reason: failed },
    });
    if (pending) return beats;
  }

  beats.push({
    id: "end",
    kind: "end",
    turn: lastTurn,
    durationMs: D.end,
    data: { status, transcriptHash: str(endEv?.payload.transcriptHash) ?? siege.transcriptHash, free },
  });
  return beats;
}

/** Index of the first beat of a turn (its packet), or -1. */
export function turnStart(beats: readonly Beat[], turn: number): number {
  return beats.findIndex((b) => b.turn === turn && b.kind === "packet");
}
