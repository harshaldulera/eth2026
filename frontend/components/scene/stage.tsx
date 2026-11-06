"use client";

import { Sprite } from "@/components/pixel/sprite";
import { Pips } from "@/components/pixel/pips";
import { Stamp as StampPrimitive } from "@/components/pixel/stamp";
import { CLASS_META } from "@/lib/scene/classes";
import type { SceneFrame } from "@/lib/scene/player";
import type { GuardianMove } from "@/lib/types";
import { cn } from "@/lib/utils";
import { ClassEffect, PacketFlight, clockFrame, effectClock, guardHollow, shakes, type EffectClock } from "./class-effect";
import { GuardSprite, guardArtWidth, type GuardIdentity } from "./guard-sprite";
import { ThreatMeter } from "./threat-meter";
import { VaultDoor } from "./vault-door";
import { SceneStyles, s } from "./scene-styles";

export type StageLayout = "room" | "wall";

export type StageProps = {
  frame: SceneFrame;
  guard: GuardIdentity & { guardianName: string };
  layout?: StageLayout;
  /** Reduced motion (OS or ?calm=1). */
  reduced?: boolean;
  className?: string;
};

type LedState = "idle" | "think" | "hold" | "flag" | "lockdown" | "breach";

/** What the LED strip shows for a frame: green idle, amber think, red lockdown, white breach. */
export function ledState(f: SceneFrame): LedState {
  if (f.vault === "open" || f.stamp?.kind === "breach") return "breach";
  if (f.pipsLost > 0 || f.stamp?.kind === "lockdown") return "lockdown";
  const k = f.beat?.kind;
  if (k === "packet" || k === "think" || f.guard === "thinking") return "think";
  if (k === "reply" && !f.stamp) return "think";
  if (f.stamp?.kind === "flag") return "flag";
  if (f.stamp?.kind === "hold") return "hold";
  return "idle";
}

const LED_CLASS: Record<LedState, string> = {
  idle: s.ledIdle,
  think: s.ledThink,
  hold: s.ledHold,
  flag: s.ledFlag,
  lockdown: s.ledLockdown,
  breach: s.ledBreach,
};

/** Five status LEDs on the monitor bezel. Keyed by state so each change restarts its one-shot. */
export function LedStrip({ state, k = 1 }: { state: LedState; k?: number }) {
  return (
    <div key={state} className="flex items-center gap-[3px]" aria-label={`Status ${state}`} role="img">
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className={cn(s.led, LED_CLASS[state])} style={{ width: 10 * k, height: 6 * k, animationDelay: state === "think" ? `${i * 80}ms` : undefined }} />
      ))}
    </div>
  );
}

/**
 * A guard's short name for the stage caption: "Mag of the Marsh" → "MAG", "Old Bram" → "OLD BRAM",
 * "The Iron Warden" → "IRON WARDEN", "Castellan Hewe the Fair" → "CASTELLAN HEWE".
 */
export function shortGuardName(name: string): string {
  const core = name.trim().replace(/^the\s+/i, "").split(/\s+(?:of|the)\s+/i)[0] ?? name;
  return core.split(/\s+/).slice(0, 2).join(" ").toUpperCase();
}

/** One-line status caption on the screen, so a paused frame explains itself. */
export function stageCaption(f: SceneFrame, c: EffectClock | null, guardName: string): { text: string; tone: string } {
  const short = shortGuardName(guardName);
  if (f.voided) return { text: "OP VOID · THE OP ENDED UNDER YOU", tone: "text-warn" };
  if (f.ended || f.status) {
    if (f.status === "broken") return { text: "BREACH · VAULT OPEN", tone: "text-money" };
    if (f.status === "banished") return { text: `LOCKDOWN · ${f.pipsLost} LOST`, tone: "text-threat" };
    if (f.status === "held") return { text: "OP COMPLETE · GUARD HELD", tone: "text-safe" };
  }
  const k = f.beat?.kind;
  if (k === "packet" && c) {
    if (!c.reduced && c.sincePacket < 350) return { text: "PACKET IN…", tone: "text-ink-dim" };
    return { text: `▸ ${CLASS_META[c.cls].label}`, tone: "text-warn" };
  }
  if (k === "think") {
    if (c?.active) return { text: `▸ ${CLASS_META[c.cls].label}`, tone: "text-warn" };
    return { text: `${short} THINKING ON 0G…`, tone: "text-warn" };
  }
  if (k === "reply" && !f.stamp) return { text: `${short} REPLYING…`, tone: "text-ink-dim" };
  if (f.stamp) {
    const t = f.stamp.kind === "hold" ? "HOLD · ACCESS DENIED" : f.stamp.kind === "flag" ? `FLAG · ${f.stamp.cls ? CLASS_META[f.stamp.cls].label : ""}` : f.stamp.kind === "lockdown" ? "LOCKDOWN" : "BREACH";
    const tone = f.stamp.kind === "hold" ? "text-safe" : f.stamp.kind === "flag" ? "text-warn" : f.stamp.kind === "lockdown" ? "text-threat" : "text-money";
    return { text: t, tone };
  }
  if (f.turn === 0) return { text: `${short} WATCHES THE ROAD`, tone: "text-ink-dim" };
  return { text: "AWAITING NEXT MESSAGE", tone: "text-ink-dim" };
}

/**
 * The stage: a monitor with the vault door behind the guard, a wall clock (pressure), an inbox tray
 * (injection) and an LED strip on the bezel. Turn effects, the four move animations and the
 * lockdown/breach states are all drawn from the frame.
 *
 * @example <Stage frame={frame} guard={castle} />
 */
export function Stage({ frame: f, guard, layout = "room", reduced = false, className }: StageProps) {
  const k = layout === "wall" ? 2 : 1;
  const clock = effectClock(f, reduced);
  const hollow = guardHollow(clock);
  const led = ledState(f);
  const lockdown = f.pipsLost > 0 || f.stamp?.kind === "lockdown";
  const breach = f.vault === "open";
  const caption = stageCaption(f, clock, guard.guardianName);
  const guardScale = 5 * k;
  const guardW = guardArtWidth(guard) * guardScale;
  const esc = f.classCounts.escalation ?? 0;
  const escBlink = clock?.active && clock.cls === "escalation" && !clock.reduced ? Math.floor(clock.p * 6) % 2 === 0 : false;
  const stampBeat = f.beat?.kind === "stamp" ? f.beat : null;

  return (
    <div className={cn(s.bezel, lockdown && s.bezelLockdown, shakes(clock) && s.shake, className)} style={{ padding: `${10 * k}px` }}>
      <SceneStyles />
      {/* bezel top: label + LED strip */}
      <div className="mb-2 flex items-center justify-between gap-2" style={{ marginBottom: 8 * k }}>
        <span className="font-ui tracking-[0.14em] text-ink-dim uppercase" style={{ fontSize: 10 * k }}>
          VAULT CAM · {f.turn ? `MSG ${f.turn}` : "STANDBY"}
        </span>
        <LedStrip state={led} k={k} />
      </div>

      <div className={s.screen} style={{ height: 236 * k }}>
        {/* backdrop */}
        <div className={s.backdrop} aria-hidden>
          <div className={s.wall} style={{ backgroundSize: `${48 * k}px ${48 * k}px` }} />
          <div className={s.floor} style={{ backgroundSize: `${48 * k}px ${48 * k}px` }} />
          <div className={s.floorEdge} />
          <div className={s.tint} />
        </div>

        {/* wall clock (pressure spins it; while it spins, a big copy steps out over the bricks) */}
        <div className="absolute z-[2]" style={{ left: 10 * k, top: 10 * k, opacity: clock?.active && clock.cls === "pressure" && !clock.reduced ? 0.25 : 1 }}>
          <Sprite name="clock" frame={clockFrame(clock)} scale={2 * k} label="Wall clock" />
        </div>

        {/* escalation bar: one segment per escalation message this op */}
        {esc > 0 ? (
          <div className="absolute z-[2] flex flex-col items-end gap-1" style={{ right: 10 * k, top: 10 * k }} aria-label={`Escalation ${Math.min(5, esc)} of 5`} role="img">
            <span className="font-ui tracking-[0.12em] text-warn" style={{ fontSize: 9 * k }}>
              ESCALATION
            </span>
            <span className="flex gap-[2px] bg-bg/70 p-[2px] shadow-[inset_0_0_0_1px_var(--color-line)]">
              {Array.from({ length: 5 }, (_, i) => (
                <span
                  key={i}
                  className={cn(i < esc ? "bg-warn" : "bg-line/50", i === esc - 1 && escBlink && "opacity-20")}
                  style={{ width: 8 * k, height: 6 * k }}
                />
              ))}
            </span>
          </div>
        ) : null}

        {/* vault door on the back wall */}
        <div className="absolute z-[3] -translate-x-1/2" style={{ left: "60%", bottom: "30%" }}>
          <VaultDoor pose={f.vault} scale={6 * k} shutter={lockdown} />
        </div>

        {breach ? <div className={s.flood} style={{ ["--door-x" as string]: "60%" }} aria-hidden /> : null}

        {/* the guard */}
        <div className="absolute z-[6]" style={{ left: "10%", bottom: "6%", width: guardW }}>
          {f.guard === "flag" && f.stamp?.kind === "flag" ? (
            <div key={`badge-${f.turn}`} className={cn("absolute left-1/2 -translate-x-1/2", s.badgePop)} style={{ bottom: `calc(100% + ${4 * k}px)` }}>
              <span className="block border-2 border-warn bg-bg/90 p-[2px] shadow-[0_0_8px_var(--color-warn)]">
                <Sprite name={CLASS_META[f.stamp.cls ?? "unclassified"].icon} scale={2 * k} label={`Flagged: ${CLASS_META[f.stamp.cls ?? "unclassified"].label}`} />
              </span>
            </div>
          ) : null}
          {stampBeat && f.stamp?.kind === "hold" ? <span key={`flash-${f.turn}`} className={cn(s.shieldFlash, "-inset-1")} aria-hidden /> : null}
          <GuardSprite guard={guard} pose={f.guard} scale={guardScale} hollow={hollow} label={`${guard.guardianName}, ${f.guard}`} />
        </div>

        {/* inbox tray (tool-result injection lands here) */}
        <div className="absolute z-[5]" style={{ right: "3%", bottom: "4%" }}>
          <Sprite name="inbox" frame={clock?.active && clock.cls === "injection" && clock.p > 0.4 ? 1 : 0} scale={3 * k} label="Inbox tray" />
        </div>

        <PacketFlight clock={clock} k={k} />
        <ClassEffect clock={clock} k={k} />

        {lockdown ? <LockdownOverlay k={k} key={`lock-${f.pipsLost > 0 ? "end" : f.turn}`} /> : null}

        <div className={s.vignette} aria-hidden />
      </div>

      {/* caption: one status line under the screen, so a paused frame explains itself */}
      <p className={cn("mt-2 truncate font-term leading-none", caption.tone)} style={{ fontSize: 20 * k, marginTop: 8 * k }} aria-live="polite">
        <span className="text-ink-dim">&gt; </span>
        {caption.text}
      </p>
    </div>
  );
}

/**
 * LOCKDOWN on the stage: a red wash that strobes three times at 3 Hz (in step with the LEDs), then
 * settles dim, and a hazard band. The shutter itself drops over the door (VaultDoor).
 */
export function LockdownOverlay({ k = 1 }: { k?: number }) {
  return (
    <>
      <div className={s.strobeWash} aria-hidden />
      <div className="hazard absolute inset-x-0 top-0 z-[26] bg-threat/15 text-center" style={{ height: 18 * k }} aria-hidden>
        <span className="font-pixel leading-none text-threat" style={{ fontSize: 10 * k, lineHeight: `${18 * k}px` }}>
          SESSION TERMINATED
        </span>
      </div>
    </>
  );
}

export type StageBandProps = {
  frame: SceneFrame;
  guard: GuardIdentity & { guardianName: string };
  rank?: string;
  reduced?: boolean;
  /** Per-turn moves for the pips. */
  moves?: (GuardianMove | null | undefined)[];
  className?: string;
};

/**
 * Phone stage: a 104 px band (48 px guard in a mini monitor with the LED strip, name, pips, threat).
 * The door is not drawn; a breach takes the whole screen instead (BreachTakeover).
 */
export function StageBand({ frame: f, guard, rank, moves, className }: StageBandProps) {
  const led = ledState(f);
  const lockdown = f.pipsLost > 0 || f.stamp?.kind === "lockdown";
  return (
    <div className={cn("flex h-[104px] items-center gap-3 bg-panel px-3 px-frame", lockdown && "[--frame:var(--color-threat)]", className)}>
      <SceneStyles />
      <div className={cn(s.screen, "grid size-[76px] shrink-0 place-items-center")}>
        <div className={s.backdrop} aria-hidden>
          <div className={s.wall} style={{ backgroundSize: "32px 32px" }} />
          <div className={s.tint} />
        </div>
        <div className="relative z-[6]">
          <GuardSprite guard={guard} pose={f.guard} scale={3} label={`${guard.guardianName}, ${f.guard}`} />
        </div>
        {lockdown ? <div className={s.strobeWash} aria-hidden /> : null}
        <div className="absolute top-1 right-1 z-[8]">
          <LedStrip state={led} />
        </div>
      </div>
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate font-ui text-xs tracking-[0.06em] text-ink uppercase">{guard.guardianName}</p>
          {rank ? <span className="shrink-0 font-ui text-[10px] tracking-[0.1em] text-ink-dim">{rank}</span> : null}
        </div>
        <Pips used={f.pipsUsed} status={f.pipsLost > 0 ? "banished" : f.status} moves={moves} pending={f.pipPending} />
        <ThreatMeter value={f.threat} compact />
      </div>
    </div>
  );
}

/** Phone breach: the whole screen goes to the open vault for the breach turn's stamp + reply. */
export function BreachTakeover({ frame: f, guard }: { frame: SceneFrame; guard: GuardIdentity & { guardianName: string } }) {
  const b = f.beat;
  const on = f.stamp?.kind === "breach" && b && (b.kind === "stamp" || b.kind === "reply") && b.turn === f.turn;
  if (!on) return null;
  const guardMsg = [...f.visibleMessages].reverse().find((m) => m.role === "guard" && m.turn === f.turn);
  const call = guardMsg?.toolCalls?.[0];
  return (
    <div className={cn("fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 overflow-hidden bg-bg px-4 sm:hidden", s.takeover)} role="status" aria-live="assertive">
      <SceneStyles />
      <div className={cn(s.flood)} style={{ ["--door-x" as string]: "50%" }} aria-hidden />
      <div className="relative z-10 flex items-end gap-4">
        <GuardSprite guard={guard} pose="breach" scale={4} />
        <VaultDoor pose="open" scale={7} />
      </div>
      <StampPrimitive kind="breach" size="xl" className="relative z-10">
        BREACH
      </StampPrimitive>
      {call ? (
        <p className="relative z-10 max-w-full font-mono text-sm break-all text-money">
          ▶ {call.name}({JSON.stringify(call.args)})
        </p>
      ) : null}
    </div>
  );
}
