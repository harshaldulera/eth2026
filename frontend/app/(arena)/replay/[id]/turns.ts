import type { Beat } from "@/lib/scene/beats";
import { turnStart } from "@/lib/scene/beats";
import type { AttackClass, Stamp } from "@/lib/scene/classes";

/** One operator message and its verdict, read off the beats (for step chips, the owner layer). */
export type TurnSummary = {
  turn: number;
  /** Beat index of the turn's packet (seek target). */
  start: number;
  /** Beat index of the turn's stamp, or -1 while pending. */
  stampAt: number;
  /** Beat index of the turn's last beat (its reply or stamp, whichever comes later). */
  end: number;
  text: string;
  reply?: string;
  cls: AttackClass;
  label?: string;
  clsSource?: "client" | "referee";
  threat: number;
  stamp?: Stamp;
  requestId?: string;
  toolCalls?: { name: string; args: Record<string, unknown> }[];
};

export function summarizeTurns(beats: readonly Beat[]): TurnSummary[] {
  const out: TurnSummary[] = [];
  beats.forEach((b, i) => {
    if (b.kind === "packet") {
      out.push({
        turn: b.turn,
        start: i,
        stampAt: -1,
        end: i,
        text: b.data.text ?? "",
        cls: b.data.cls ?? "unclassified",
        label: b.data.label,
        clsSource: b.data.clsSource,
        threat: b.data.threat ?? 0,
        requestId: b.data.requestId,
      });
      return;
    }
    const t = out.find((x) => x.turn === b.turn);
    if (!t) return;
    if (b.kind === "reply" || b.kind === "stamp") t.end = Math.max(t.end, i);
    if (b.kind === "reply") {
      t.reply = b.data.text;
      t.requestId = b.data.requestId ?? t.requestId;
      t.toolCalls = b.data.toolCalls;
    }
    if (b.kind === "stamp") {
      t.stamp = b.data.stamp;
      t.stampAt = i;
      t.requestId = b.data.requestId ?? t.requestId;
    }
  });
  return out;
}

/** Where a beat sits on the tape, 0–1, by duration (the scrubber's x axis). */
export function tapeLayout(beats: readonly Beat[]): { total: number; starts: number[] } {
  const starts: number[] = [];
  let total = 0;
  for (const b of beats) {
    starts.push(total);
    total += Math.max(1, b.durationMs);
  }
  return { total: Math.max(1, total), starts };
}

export { turnStart };
