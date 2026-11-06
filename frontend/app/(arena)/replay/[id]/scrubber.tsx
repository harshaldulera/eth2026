"use client";

import * as React from "react";
import { Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from "lucide-react";
import type { Beat } from "@/lib/scene/beats";
import type { PlayerControls } from "@/lib/scene/usePlayer";
import { SPEEDS, type PlayerState } from "@/lib/scene/player";
import { PixelButton } from "@/components/pixel";
import { cn } from "@/lib/utils";
import { tapeLayout, type TurnSummary } from "./turns";

const STAMP_BG = { hold: "bg-stamp-hold", flag: "bg-stamp-flag", lockdown: "bg-stamp-lockdown", breach: "bg-stamp-breach" } as const;
const STAMP_TEXT = { hold: "text-stamp-hold", flag: "text-stamp-flag", lockdown: "text-stamp-lockdown", breach: "text-stamp-breach" } as const;

/**
 * The tape. One track whose length is the op's running time; a notch per message (1–N) in its
 * verdict colour; a playhead. Click or drag the track to seek a beat; transport keys underneath.
 * Keyboard (when the page has focus): ←/→ beat, Shift+←/→ message, 1–5 jump, Space play, [ ] speed.
 */
export function Scrubber({
  beats,
  turns,
  state,
  controls,
  className,
}: {
  beats: readonly Beat[];
  turns: TurnSummary[];
  state: PlayerState;
  controls: PlayerControls;
  className?: string;
}) {
  const { total, starts } = React.useMemo(() => tapeLayout(beats), [beats]);
  const beat = beats[state.index];
  const at = beat ? (starts[state.index] + Math.min(state.elapsedInBeat, beat.durationMs)) / total : 0;
  const trackRef = React.useRef<HTMLDivElement>(null);
  const dragging = React.useRef(false);

  const seekAtX = (clientX: number) => {
    const el = trackRef.current;
    if (!el || !beats.length) return;
    const r = el.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width))) * total;
    let i = 0;
    while (i < starts.length - 1 && starts[i + 1] <= t) i++;
    controls.seek(i);
  };

  const ended = beats.at(-1)?.kind === "end";
  const lastTurn = turns.at(-1)?.turn ?? 0;
  const currentTurn = beat?.turn ?? 0;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {/* track */}
      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="Replay position"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, beats.length - 1)}
        aria-valuenow={state.index}
        aria-valuetext={beat ? `Message ${beat.turn || 0} of ${lastTurn}, ${beat.kind}` : "start"}
        className="relative h-9 cursor-pointer touch-none bg-bg px-frame select-none [--bevel-hi:rgb(0_0_0/0.45)] [--bevel-lo:var(--bevel-hi)] focus-visible:outline-2 focus-visible:outline-accent"
        onPointerDown={(e) => {
          dragging.current = true;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          seekAtX(e.clientX);
        }}
        onPointerMove={(e) => dragging.current && seekAtX(e.clientX)}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
      >
        {/* played part */}
        <div aria-hidden className="absolute inset-y-0 left-0 bg-accent/15" style={{ width: `${(at * 100).toFixed(3)}%` }} />
        {/* turn notches */}
        {turns.map((t) => {
          const x = starts[t.start] / total;
          const kind = t.stamp?.kind;
          return (
            <div key={t.turn} aria-hidden className="absolute inset-y-0 flex flex-col items-center" style={{ left: `${(x * 100).toFixed(3)}%` }}>
              <span className={cn("mt-1 h-4 w-1.5", kind ? STAMP_BG[kind] : "bg-ink-dim/60")} />
              <span className={cn("mt-0.5 font-ui text-[10px] leading-none", kind ? STAMP_TEXT[kind] : "text-ink-dim", t.turn === currentTurn && "glow")}>{t.turn}</span>
            </div>
          );
        })}
        {/* end marker */}
        {ended ? <span aria-hidden className="absolute top-1 right-1 h-4 w-1 bg-ink-dim" /> : null}
        {/* playhead */}
        <div aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 bg-ink shadow-[0_0_6px_var(--color-accent)]" style={{ left: `${(at * 100).toFixed(3)}%` }}>
          <span className="absolute -top-1 -left-[3px] block size-2 bg-ink" />
        </div>
      </div>

      {/* transport */}
      <div className="flex flex-wrap items-center gap-1.5">
        <PixelButton size="icon" variant="ghost" cue={null} aria-label="Previous message (Shift+←)" onClick={() => controls.stepTurn(-1)}>
          <SkipBack />
        </PixelButton>
        <PixelButton size="icon" variant="ghost" cue={null} aria-label="Previous step (←)" onClick={() => controls.step(-1)}>
          <StepBack />
        </PixelButton>
        <PixelButton size="icon" variant={state.playing ? "outline" : "money"} cue="ui_confirm" aria-label={state.playing ? "Pause (Space)" : "Play (Space)"} onClick={() => controls.toggle()}>
          {state.playing ? <Pause /> : <Play />}
        </PixelButton>
        <PixelButton size="icon" variant="ghost" cue={null} aria-label="Next step (→)" onClick={() => controls.step(1)}>
          <StepForward />
        </PixelButton>
        <PixelButton size="icon" variant="ghost" cue={null} aria-label="Next message (Shift+→)" onClick={() => controls.stepTurn(1)}>
          <SkipForward />
        </PixelButton>
        <span className="ml-1 font-term text-lg leading-none text-ink-dim tabular-nums">
          MSG {currentTurn || "–"}/{lastTurn || "–"}
        </span>
        <div className="ml-auto flex items-center gap-1" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <PixelButton key={s} size="sm" variant="ghost" pressed={state.speed === s} cue="ui_blip" onClick={() => controls.setSpeed(s)} className="min-h-7 px-2">
              {s}×
            </PixelButton>
          ))}
        </div>
      </div>
    </div>
  );
}
