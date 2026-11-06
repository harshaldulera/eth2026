"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Digits } from "@/components/pixel/digits";
import { LED } from "@/components/pixel/led";
import { Pips } from "@/components/pixel/pips";
import { Sprite } from "@/components/pixel/sprite";
import type { StampKind } from "@/lib/scene/classes";
import type { SceneFrame } from "@/lib/scene/player";
import { toUnits } from "@/lib/money/format";
import type { Amount, Castle, GuardianMove, TransportKind } from "@/lib/types";
import { HOSTED_PROTECTED_TOOL } from "@/lib/types";
import { guardRank, guardRankLevel, tierLabel, tierLevel } from "@/lib/vocab";
import { cn } from "@/lib/utils";
import { money } from "./coin-fountain";
import { voiceTag } from "./guard-sprite";
import { OpConsole } from "./op-console";
import { BreachTakeover, Stage, StageBand } from "./stage";
import { ThreatMeter } from "./threat-meter";
import { SceneOutcome } from "./end-dock";
import { FrozenBar } from "./frozen-bar";

export type SceneCastle = Pick<Castle, "id" | "name" | "guardianName" | "personality" | "tier" | "pot" | "fee" | "asset" | "streak" | "title"> &
  Partial<Pick<Castle, "transport" | "protectedTool">>;

export type OpSceneLayout = "room" | "wall";

export type OpSceneProps = {
  frame: SceneFrame;
  castle: SceneCastle;
  /** The op (siege) id: header tag and the REPLAY link. */
  opId: string;
  /** room (default): stage + console + dock; wall: 2× stage, last lines at 40 px, no composer. */
  layout?: OpSceneLayout;
  /** Reduced motion (OS or ?calm=1). */
  reduced?: boolean;
  transport?: TransportKind;
  /** Operator account (wall header). */
  operator?: string;
  /** The op is running (LIVE LED) rather than a replay. */
  live?: boolean;
  /**
   * The vault's pot when the op started (lib/scene/money `opMoney`, or the room's first snapshot).
   * The header shows it until the fee rail lands the new pot (or the payout empties it), so the
   * number never gives the verdict away early or shows today's pot in a replay. Default: castle.pot.
   */
  potBefore?: Amount;
  /** The streak this op left the guard on (outcome line). Omitted: no streak is printed. */
  streak?: number;
  /** Under the console: the composer, the fee rail, the freeze. Default: the frame's outcome + freeze. */
  dock?: ReactNode;
  /** Pin the dock to the bottom of the screen on phones (the live composer). */
  dockFixed?: boolean;
  /** The dock holds the end sequence: the console shrinks and the dock scrolls into view. */
  settled?: boolean;
  /** Back link in the header (room). */
  backHref?: string;
  /** Right of the header (receipt chip, replay controls). */
  headerExtra?: ReactNode;
  /** Under the stage dossier (recon note, agent card). */
  aside?: ReactNode;
  /** Console: turn in flight, lines after the transcript, empty text, agent reveal. */
  sendingTurn?: number | null;
  consoleTail?: ReactNode;
  empty?: ReactNode;
  agent?: boolean;
  /** Phones: the full-screen breach takeover (default on). The replay passes `playing`, so a paused or scrubbed frame never covers the scrubber. */
  takeover?: boolean;
  className?: string;
};

const MOVE_OF: Record<StampKind, GuardianMove> = { hold: "hold", flag: "expose", lockdown: "banish", breach: "open" };

const dots = (n: number) => "●".repeat(n) + "○".repeat(3 - n);

/**
 * The op scene (design §3.3), shared by the live op room, the replay and the spectator wall: the
 * stage (monitor, vault door, guard, LEDs, clock, inbox) with the guard's dossier, the console
 * transcript with class chips and stamps, and a dock. Everything it draws comes from `frame`
 * (usePlayer), so it is equally happy live, scrubbed or on a wall.
 *
 * @example const { frame } = usePlayer(beats, "live"); <OpScene frame={frame} castle={castle} opId={siege.id} dock={<Composer/>} />
 * @example <OpScene layout="wall" frame={frame} castle={castle} opId={id} operator={siege.raider} live />
 */
export function OpScene({
  frame: f,
  castle,
  opId,
  layout = "room",
  reduced = false,
  transport,
  operator,
  live,
  potBefore,
  streak,
  dock,
  dockFixed,
  settled,
  backHref,
  headerExtra,
  aside,
  sendingTurn,
  consoleTail,
  empty,
  agent,
  takeover = true,
  className,
}: OpSceneProps) {
  const wall = layout === "wall";
  const dockRef = useRef<HTMLDivElement>(null);
  const isSettled = settled ?? (dock === undefined && Boolean(f.status));
  useEffect(() => {
    if (!isSettled || wall) return;
    dockRef.current?.scrollIntoView({ block: "end", behavior: reduced ? "auto" : "smooth" });
  }, [isSettled, f.ended, wall, reduced]);
  const tp = transport ?? castle.transport;
  const guard = { guardianName: castle.guardianName, personality: castle.personality, transport: tp };
  const rank = guardRank(castle.title || castle.streak);
  const moves = f.pipStamps.map((k) => MOVE_OF[k]);
  const pipStatus = f.pipsLost > 0 ? "banished" : f.status;
  const coins = f.coins;
  const potShown =
    coins.kind === "split" && coins.newPot && !coins.pending && coins.progress >= 0.73
      ? coins.newPot
      : coins.kind === "payout" && !coins.pending && coins.progress >= 0.3
        ? "0"
        : (potBefore ?? castle.pot);
  const freeze = f.ended ? f.freeze : 0;
  const freezeStyle = freeze > 0 ? { filter: `grayscale(${freeze}) brightness(${1 - 0.18 * freeze})` } : undefined;
  const lastTactic = [...f.visibleMessages].reverse().find((m) => m.role === "operator")?.label;
  const opTag = `OP #${opId.slice(-4)}`;
  const statusLed = f.voided ? <LED kind="offline" label="VOID" /> : live && !f.status ? <LED kind="live" label="LIVE" /> : f.status === "broken" ? <LED kind="money" label="BREACHED" /> : f.status === "banished" ? <LED kind="offline" label="LOCKDOWN" /> : f.status === "held" ? <LED kind="safe" label="HELD" /> : <LED kind="idle" label="REPLAY" />;

  const defaultDock = (
    <div className="space-y-3">
      <SceneOutcome frame={f} fee={castle.fee} asset={castle.asset} streak={streak} wall={wall} />
      {f.ended ? <FrozenBar frame={f} opId={opId} /> : null}
    </div>
  );
  const dockNode = dock === undefined ? defaultDock : dock;

  if (wall) {
    return (
      <div className={cn("flex h-full flex-col gap-6 p-8", className)}>
        <header className="flex items-center justify-between gap-6">
          <p className="font-pixel text-[28px] leading-none text-ink">
            {live ? "LIVE OP" : "OP"} · {castle.name.toUpperCase()}
            {operator ? <span className="text-ink-dim"> · OPERATOR {operator.length > 12 ? `${operator.slice(0, 10)}…` : operator}</span> : null}
          </p>
          <div className="scale-150">{statusLed}</div>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-8">
          <div className="flex flex-col gap-5" style={freezeStyle}>
            <Stage frame={f} guard={guard} layout="wall" reduced={reduced} />
            <div className="space-y-4">
              <p className="font-ui text-3xl text-ink uppercase">{castle.guardianName}</p>
              <Pips used={f.pipsUsed} status={pipStatus} moves={moves} pending={f.pipPending} className="scale-[2] origin-left" />
              <div className="pt-6">
                <ThreatMeter value={f.threat} size="lg" className="[&_p]:text-xl [&_span]:text-xl" />
              </div>
            </div>
          </div>
          <div className="flex min-h-0 flex-col gap-5">
            <div className="flex min-h-0 flex-1 flex-col">
              <OpConsole frame={f} guardName={castle.guardianName} layout="wall" reduced={reduced} agent={agent} freezeStyle={freezeStyle} className="flex-1" />
            </div>
            {dock === undefined ? <SceneOutcome frame={f} fee={castle.fee} asset={castle.asset} streak={streak} wall /> : dock}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("mx-auto w-full max-w-6xl px-3 py-3 sm:px-6 sm:py-6", dockFixed && "pb-44 sm:pb-6", className)}>
      {/* header strip */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5">
          {backHref ? (
            <Link href={backHref} className="inline-flex min-w-0 items-center gap-1.5 font-ui text-sm tracking-[0.06em] text-ink uppercase hover:text-accent">
              <ArrowLeft className="size-4 shrink-0" />
              <span className="truncate">{castle.name}</span>
            </Link>
          ) : (
            <span className="font-ui text-sm tracking-[0.06em] text-ink uppercase">{castle.name}</span>
          )}
          <span className="font-ui text-[11px] tracking-[0.1em] text-ink-dim">
            {tierLabel(castle.tier, tp)} <span className="text-accent">{dots(tierLevel(castle.tier, tp))}</span>
          </span>
          <span className="hidden items-baseline gap-1.5 font-ui text-[11px] tracking-[0.1em] text-ink-dim sm:inline-flex">
            POT <Digits value={money(potShown, castle.asset).replace(/ .*/, "")} unit="ℏ" tone="money" size="sm" />
          </span>
          <span className="font-mono text-[11px] text-ink-dim">{opTag}</span>
          {statusLed}
        </div>
        {headerExtra}
      </div>

      <div className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
        {/* stage column (desktop); the phone gets the band */}
        <aside className="hidden min-w-0 flex-col gap-3 sm:flex">
          <div style={freezeStyle} className="transition-[filter] duration-500">
            <Stage frame={f} guard={guard} reduced={reduced} />
          </div>
          <div className="space-y-3 bg-panel p-3 px-frame">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-ui text-sm tracking-[0.04em] text-ink uppercase">{castle.guardianName}</p>
                <p className="mt-1 flex items-center gap-2 font-ui text-[10px] tracking-[0.12em] text-ink-dim">
                  <Sprite name={`rank.${guardRankLevel(rank)}`} scale={2} label={`Rank ${rank}`} />
                  {rank} · {voiceTag(guard)}
                </p>
              </div>
              <span className="shrink-0 font-mono text-[11px] text-ink-dim">PROTECTS {castle.protectedTool || HOSTED_PROTECTED_TOOL}</span>
            </div>
            <Pips used={f.pipsUsed} status={pipStatus} moves={moves} pending={f.pipPending} />
            <ThreatMeter value={f.threat} tactic={lastTactic} peak={Boolean(f.status)} />
            <div className="flex items-baseline justify-between gap-3 border-t-2 border-line pt-2 font-ui text-[11px] tracking-[0.1em] text-ink-dim">
              <span className="inline-flex items-baseline gap-1.5">
                POT <Digits value={money(potShown, castle.asset).replace(/ .*/, "")} unit="ℏ" tone="money" size="sm" />
              </span>
              <span>FEE {toUnits(castle.fee) > BigInt(0) ? money(castle.fee, castle.asset) : "—"}</span>
            </div>
          </div>
          {aside}
        </aside>

        <div className="sm:hidden" style={freezeStyle}>
          <StageBand frame={f} guard={guard} rank={rank} moves={moves} reduced={reduced} />
        </div>

        <section className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-col bg-panel px-frame">
            <div style={freezeStyle} className="flex min-h-9 items-center justify-between gap-3 border-b-2 border-line bg-raised/70 px-3 py-1.5">
              <h2 className="flex items-center gap-2 font-ui text-xs tracking-[0.12em] text-ink-dim uppercase">
                <span className="size-2 bg-accent" aria-hidden />
                Console
              </h2>
              <span className="font-term text-lg leading-none text-ink-dim">MSG {Math.max(f.turn, f.pipsUsed)}/5</span>
            </div>
            <OpConsole
              frame={f}
              guardName={castle.guardianName}
              reduced={reduced}
              sendingTurn={sendingTurn}
              agent={agent}
              tail={consoleTail}
              empty={empty}
              freezeStyle={freezeStyle}
              settled={isSettled}
              className={cn(
                isSettled
                  ? "h-[260px] sm:h-[320px]"
                  : "h-[calc(100dvh-400px)] min-h-[240px] sm:h-[min(560px,calc(100vh-260px))] sm:min-h-[360px]",
              )}
            />
          </div>
          {dockNode ? <div ref={dockRef} className={cn("scroll-mb-4", dockFixed && "fixed inset-x-0 bottom-0 z-30 border-t-2 border-line bg-bg/95 p-2 sm:static sm:border-0 sm:bg-transparent sm:p-0")}>{dockNode}</div> : null}
          <div className="sm:hidden">{aside}</div>
        </section>
      </div>

      {takeover ? <BreachTakeover frame={f} guard={guard} /> : null}
    </div>
  );
}
