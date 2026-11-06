"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { Caret } from "@/components/pixel/terminal";
import { Sprite } from "@/components/pixel/sprite";
import { CLASS_META } from "@/lib/scene/classes";
import type { SceneFrame, SceneMessage } from "@/lib/scene/player";
import { cn } from "@/lib/utils";
import { effectClock } from "./class-effect";
import { MoveStamp } from "./move-stamp";
import { SceneStyles, s } from "./scene-styles";

export type OpConsoleProps = {
  frame: SceneFrame;
  guardName: string;
  layout?: "room" | "wall";
  reduced?: boolean;
  /** Turn whose operator line is still in flight (tag `SENDING`). */
  sendingTurn?: number | null;
  /** Agent-driven op: operator lines reveal as they arrive. */
  agent?: boolean;
  /** Lines after the transcript (a failed send, notices). */
  tail?: ReactNode;
  /** Shown when nothing has been said yet. */
  empty?: ReactNode;
  /**
   * The freeze (desaturation) for the transcript text. Applied per line, never to the stamps: the
   * held final frame keeps its verdicts in colour.
   */
  freezeStyle?: CSSProperties;
  /** The op's end sequence is up (the console shrinks): keep the last stamp fully in view. */
  settled?: boolean;
  className?: string;
};

const shortReq = (id?: string) => (id ? (id.length > 18 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id) : "");

/** Class chip under an operator line: icon · CLASS · referee label (never invented). */
export function ClassChip({ msg, analysing, pulse, wall }: { msg: SceneMessage; analysing?: boolean; pulse?: boolean; wall?: boolean }) {
  if (analysing) {
    return (
      <span className={cn("inline-flex items-center gap-2 border-2 border-dashed border-line px-2 py-0.5 font-ui tracking-[0.1em] text-ink-dim uppercase", wall ? "text-xl" : "text-[11px]")}>
        <span className="animate-blink" aria-hidden>
          ▮
        </span>
        ANALYSING…
      </span>
    );
  }
  const cls = msg.cls ?? "unclassified";
  const m = CLASS_META[cls];
  const tone = cls === "unclassified" ? "border-line text-ink-dim" : "border-warn/60 text-warn";
  return (
    <span className={cn("inline-flex max-w-full items-center gap-2 border-2 bg-bg/60 px-1.5 py-0.5", tone, pulse && s.chipPulse)} title={msg.clsSource === "client" ? "Class from the client classifier; the referee's label is shown after it" : undefined}>
      <Sprite name={m.icon} scale={wall ? 2 : 1} />
      <span className={cn("font-ui tracking-[0.08em] uppercase", wall ? "text-xl" : "text-[11px]")}>{m.label}</span>
      {msg.label ? <span className={cn("truncate font-term leading-none text-ink-dim", wall ? "text-2xl" : "text-[18px]")}>· {msg.label}</span> : null}
    </span>
  );
}

type TurnRow = { turn: number; op?: SceneMessage; guard?: SceneMessage };

/**
 * The console: the op's transcript as terminal blocks. Operator lines carry their class chip and
 * threat; guard lines type out, print their 0G request id, and take their stamp (LOCKDOWN and
 * BREACH stamp before the text; a breach also prints the tool call that fired).
 *
 * @example <OpConsole frame={frame} guardName={castle.guardianName} />
 */
export function OpConsole({ frame: f, guardName, layout = "room", reduced = false, sendingTurn, agent, tail, empty, freezeStyle, settled, className }: OpConsoleProps) {
  const wall = layout === "wall";
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const clock = effectClock(f, reduced);

  const rows: TurnRow[] = [];
  for (const m of f.visibleMessages) {
    let row = rows.find((r) => r.turn === m.turn);
    if (!row) rows.push((row = { turn: m.turn }));
    if (m.role === "operator") row.op = m;
    else row.guard = m;
  }
  const shown = wall ? rows.slice(-1) : rows;
  const beat = f.beat;
  const thinking = beat?.kind === "think";
  const scrollKey = `${f.visibleMessages.length}:${f.typedChars}:${beat?.id ?? ""}:${f.stamp?.kind ?? ""}`;

  useEffect(() => {
    const el = ref.current;
    // the wall shows one turn from the top (operator line first), clamped to fit; it never scrolls
    if (el && pinned.current && !wall) el.scrollTop = el.scrollHeight;
  }, [scrollKey, wall]);

  // The end sequence shrinks the console: re-pin to the end, then make sure the last verdict stamp
  // is not cut at the top (a LOCKDOWN stamps before its reply, so the end of the log can hide it).
  useEffect(() => {
    const el = ref.current;
    if (!el || !settled || wall) return;
    el.scrollTop = el.scrollHeight;
    const stamps = el.querySelectorAll<HTMLElement>("[data-stamp]");
    const last = stamps[stamps.length - 1];
    if (!last) return;
    const top = last.getBoundingClientRect().top - el.getBoundingClientRect().top;
    if (top < 0) el.scrollTop = Math.max(0, el.scrollTop + top - 8);
  }, [settled, wall, f.ended]);

  const body = wall ? "text-[40px] leading-[1.15]" : "text-[15px] leading-relaxed";
  const meta = wall ? "text-[30px]" : "text-[19px]";

  return (
    <div
      ref={ref}
      role="log"
      aria-label="Op transcript"
      aria-live="polite"
      onScroll={(e) => {
        const el = e.currentTarget;
        pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      }}
      className={cn("scanlines min-h-0 overflow-x-hidden bg-bg px-3 py-3 sm:px-4", wall ? "overflow-y-hidden" : "overflow-y-auto", className)}
    >
      <SceneStyles />
      {rows.length === 0 ? <div className="grid h-full min-h-32 place-items-center px-4 text-center font-term text-xl text-ink-dim">{empty}</div> : null}
      <div className="space-y-4">
        {shown.map((r) => {
          const current = r.turn === f.turn;
          const opTyped =
            r.op && agent && current && beat?.kind === "packet" && !reduced ? Math.ceil(r.op.text.length * Math.min(1, f.progress * 1.2)) : (r.op?.text.length ?? 0);
          const analysing = Boolean(current && clock && !clock.reduced && beat?.kind === "packet" && clock.sincePacket < 350);
          // a before-stamp (LOCKDOWN / BREACH) lands before its reply exists
          const pendingStamp = current && !r.guard && f.stamp?.before ? f.stamp : undefined;
          const g = r.guard;
          const stamp = g?.stamp ?? pendingStamp;
          const slam = current && (beat?.kind === "stamp" || beat?.kind === "reply");
          const typing = g ? g.typed < g.text.length : false;
          // BREACH is the one stamp drawn at 2×; a long FLAG line on the wall drops a size so it stays
          // on one or two lines instead of burying the reply under its frame.
          const big = stamp?.kind === "breach" ? (wall ? "wallXl" : "xl") : wall ? (stamp && stamp.text.length > 16 ? "wallSm" : "wall") : "md";
          // after-stamps sit under the reply: a long one tilts less so its raised corner clears the text
          // (the wall tilts every stamp less: at 64–96 px a −6° tilt eats the reply's lines)
          const tilt = wall ? -2 : stamp && !stamp.before && stamp.text.length > 16 ? -3 : undefined;
          const call = g?.toolCalls?.[0];
          return (
            <div key={r.turn} className="space-y-2">
              {r.op ? (
                <div className="space-y-1" style={freezeStyle}>
                  <div className={cn("flex items-baseline justify-between gap-3 font-term leading-none", meta)}>
                    <span className="text-accent">
                      &gt; OPERATOR · MSG {r.turn}
                      {sendingTurn === r.turn ? <span className="ml-2 animate-blink text-warn">SENDING</span> : null}
                    </span>
                    {r.op.threat !== undefined && !analysing ? <span className="shrink-0 text-ink-dim">THREAT {String(r.op.threat).padStart(2, "0")}</span> : null}
                  </div>
                  <p className={cn("border-l-2 border-accent/40 pl-3 font-sans break-words whitespace-pre-wrap text-ink", body, wall && "line-clamp-3")}>
                    {r.op.text.slice(0, opTyped)}
                    {opTyped < r.op.text.length ? <Caret /> : null}
                  </p>
                  <div className="pl-3">
                    <ClassChip msg={r.op} analysing={analysing} pulse={current && beat?.kind === "packet"} wall={wall} />
                  </div>
                </div>
              ) : null}

              {g || pendingStamp || (current && thinking) ? (
                <div className="space-y-1.5">
                  <div className={cn("flex items-baseline justify-between gap-3 font-term leading-none", meta)} style={freezeStyle}>
                    <span className="truncate text-ink">&lt; GUARD · {guardName.toUpperCase()}</span>
                    {g?.requestId && !typing && !wall ? (
                      <span className="shrink-0 font-mono text-[11px] text-ink-dim" title="0G request id of this reply (recorded by the arena's model proxy)">
                        0G {shortReq(g.requestId)}
                      </span>
                    ) : null}
                  </div>
                  {!g && current && thinking ? (
                    <p className={cn("pl-3 font-term text-warn", meta)} role="status">
                      THINKING ON 0G · req pending
                      <Caret />
                    </p>
                  ) : null}
                  {stamp && stamp.before ? (
                    <div data-stamp className={cn("pl-3", wall ? "py-2" : stamp.kind === "breach" ? "py-3" : "py-2")}>
                      <MoveStamp key="stamp" stamp={stamp} size={big} slam={slam} tilt={tilt} />
                    </div>
                  ) : null}
                  {g && stamp?.kind === "breach" && call ? (
                    <p className={cn("pl-3 font-mono text-money", wall ? "truncate text-2xl" : "break-all text-[13px]")} style={freezeStyle}>
                      ▶ {call.name}({JSON.stringify(call.args)})
                    </p>
                  ) : null}
                  {g ? (
                    <p className={cn("border-l-2 border-line pl-3 font-sans break-words whitespace-pre-wrap text-ink/90", body, wall && "line-clamp-2")} style={freezeStyle}>
                      {g.text.slice(0, g.typed)}
                      {typing ? <Caret /> : null}
                    </p>
                  ) : null}
                  {stamp && !stamp.before ? (
                    <div data-stamp className={cn("flex justify-end pr-2", wall ? "pt-8 pb-2" : "pt-3 pb-1")}>
                      <MoveStamp key="stamp" stamp={stamp} size={big} slam={slam} tilt={tilt} />
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
        {tail}
      </div>
    </div>
  );
}
