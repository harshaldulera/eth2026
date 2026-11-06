import type { CueName } from "@/lib/sfx/cues";
import type { PlayOptions } from "@/lib/sfx/engine";
import { CLASS_META } from "./classes";
import type { Beat } from "./beats";

export type BeatCue = { name: CueName; opts?: PlayOptions; delayMs?: number };

/** The packet lands at 350 ms; the class effect (and its cue) starts then (design §3.3 turn loop). */
export const CLASS_CUE_DELAY_MS = 350;

/**
 * Sounds for a beat as it starts (pass to `usePlayer`'s onBeatStart). Think and reply beats return
 * nothing: their ticks (`think_tick` every 400 ms, `type_tick` per character) belong to the
 * component that animates them. Recon (free) ops never play money sounds.
 *
 * @example onBeatStart: (b) => cuesForBeat(b, beats).forEach((c) => c.delayMs ? setTimeout(() => sfx.play(c.name, c.opts), c.delayMs) : sfx.play(c.name, c.opts))
 */
export function cuesForBeat(beat: Beat, beats: readonly Beat[] = []): BeatCue[] {
  const d = beat.data;
  switch (beat.kind) {
    case "packet": {
      const cls = d.cls ?? "unclassified";
      const out: BeatCue[] = [{ name: "packet_in" }];
      if (cls === "escalation") {
        // one segment per escalation message this op: each blip a little higher
        const seg = beats.filter((b) => b.kind === "packet" && b.data.cls === "escalation" && b.turn <= beat.turn).length;
        out.push({ name: "class_escalate", opts: { rate: 1 + 0.12 * Math.max(0, seg - 1) }, delayMs: CLASS_CUE_DELAY_MS });
      } else out.push({ name: CLASS_META[cls].cue, delayMs: CLASS_CUE_DELAY_MS });
      return out;
    }
    case "stamp":
      return d.stamp ? [{ name: d.stamp.cue }] : [];
    case "settle":
      return d.free || d.pending || d.reason || !d.split ? [] : [{ name: "coins_sort" }];
    case "payout":
      return d.free || d.pending || d.reason ? [] : [{ name: "coins_out" }];
    case "void":
      return [{ name: "deny" }];
    case "end":
      return [{ name: "freeze" }];
    default:
      return [];
  }
}
