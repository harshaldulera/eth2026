"use client";

import * as React from "react";
import type { ApprovalRequest, Castle, StoredSiegeEvent } from "@/lib/types";
import { api, type BreachExhibit, type LiveSiege, type ReplayResponse, type StatsResponse } from "@/lib/api/client";
import { usePolling, useNow } from "@/lib/hooks/usePolling";
import { formatAmount, shortAccount, timeAgo } from "@/lib/money/format";
import { vaultStateOf } from "@/lib/money/vault";
import { guardKind, guardSprite } from "@/lib/pixel/manifest";
import { toBeats, turnStart } from "@/lib/scene/beats";
import { opMoney } from "@/lib/scene/money";
import { usePlayer } from "@/lib/scene/usePlayer";
import { CLASS_META, classFor, type AttackClass } from "@/lib/scene/classes";
import { guardRank, guardRankLevel, threatWord, tierLabel } from "@/lib/vocab";
import { Digits, LED, Meter, Pips, Stamp } from "@/components/pixel";
import { Sprite } from "@/components/pixel/sprite";
import { OpScene, useBeatCues, useTickSounds } from "@/components/scene";
import { GuardPost, GridTicker, PotDigits, RankChevrons } from "@/components/grid";
import { capLine, askText } from "@/components/money/approval-card";
import { setupProgress, vaultStateLed } from "@/components/arena/vault-state";
import { cn } from "@/lib/utils";

/** How long the ending stays up after the freeze before the LIVE OP slide hands over (design §3.3). */
export const AFTER_FREEZE_MS = 4_000;

/** The op is final: ended and its money event landed (or will never land). */
function settled(r: ReplayResponse): boolean {
  const s = r.siege;
  if (s.status === "created" || s.status === "in_progress") return false;
  if (s.settlement?.state === "failed" || s.settlement?.state === "void") return true;
  const money = s.status === "broken" ? "release" : "attempt";
  return r.events.some((e: StoredSiegeEvent) => e.type === money);
}

/** A wall-sized label: never under 24 px (readable at 4 m). */
function Label({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("font-ui text-[24px] leading-none tracking-[0.14em] text-ink-dim uppercase", className)}>{children}</p>;
}

/** Part 1 LEDs are 11 px; on the wall they are drawn at 2.4× (24 px+ text, crisp square dot). */
function BigLed(props: React.ComponentProps<typeof LED>) {
  return <LED {...props} className={cn("text-[26px] tracking-[0.12em] [&>span:first-child]:size-4", props.className)} />;
}

function Loading({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center" role="status">
      <p className="font-term text-[40px] text-ink-dim">
        &gt; {text}
        <span className="ml-1 inline-block h-[0.9em] w-[0.5em] animate-caret bg-ink-dim align-[-0.1em]" aria-hidden />
      </p>
    </div>
  );
}

// ─── LIVE OP / LAST BREACH / interrupts: the op scene at wall size ─────────────────────────────

export type OpSlideProps = {
  siegeId: string;
  /** live: follow the op as it happens; replay: auto-play it from its last turn. */
  mode: "live" | "replay";
  sound: boolean;
  calm: boolean;
  /** The LIVE OP slide: called once the ending has been up for AFTER_FREEZE_MS. */
  onDone?: () => void;
  /** Shown because the feed just reported this (banner over the scene). */
  interrupt?: "breach" | "lockdown";
};

/** The op scene in its wall layout (stage 2×, last lines at 40 px, no composer). */
export function OpSlide({ siegeId, mode, sound, calm, onDone, interrupt }: OpSlideProps) {
  const [final, setFinal] = React.useState(false);
  const { data, error } = usePolling(() => api.replay(siegeId), mode === "live" ? 1_000 : 1_500, { key: siegeId, enabled: !final });
  const isFinal = data ? settled(data) : false;
  if (isFinal !== final) setFinal(isFinal);
  if (!data) return <Loading text={error ? "op feed offline · retrying" : "tuning the vault cam"} />;
  return (
    <div className="flex h-full flex-col">
      {interrupt ? <InterruptBanner kind={interrupt} castleName={data.castle.name} /> : null}
      {/* Under a banner (interrupt / LAST BREACH strip) the scene's own title row repeats the vault
          name: drop it so the stage, the meters and the payout fit the 1080 px canvas. */}
      <div className="min-h-0 flex-1" data-wall-scene={interrupt ? "interrupt" : mode === "replay" ? "bare" : undefined}>
        <OpPlayer key={siegeId} replay={data} mode={mode} sound={sound} calm={calm} onDone={onDone} />
      </div>
    </div>
  );
}

function OpPlayer({ replay, mode, sound, calm, onDone }: { replay: ReplayResponse; mode: "live" | "replay"; sound: boolean; calm: boolean; onDone?: () => void }) {
  const { siege, events, castle } = replay;
  const beats = React.useMemo(() => toBeats(siege, events, castle, { mode, reducedMotion: calm }), [siege, events, castle, mode, calm]);
  const cash = React.useMemo(() => opMoney(siege, events, castle.fee), [siege, events, castle.fee]);
  const onBeatStart = useBeatCues(beats, sound);
  const { frame, controls } = usePlayer(beats, mode, { onBeatStart, autoPlay: mode === "replay" });
  useTickSounds(frame, sound);

  // Replay: start at the last turn, so the verdict (and the payout) land inside the slide's time.
  const sought = React.useRef(false);
  React.useEffect(() => {
    if (mode !== "replay" || sought.current || !beats.length) return;
    sought.current = true;
    const last = beats.reduce((m, b) => Math.max(m, b.turn), 0);
    const i = turnStart(beats, last);
    if (i > 0) controls.seek(i);
  }, [mode, beats, controls]);

  // LIVE OP: hand over a few seconds after the freeze.
  const frozen = frame.ended && frame.freeze >= 1;
  const done = React.useEffectEvent(() => onDone?.());
  React.useEffect(() => {
    if (!frozen) return;
    const t = setTimeout(done, AFTER_FREEZE_MS);
    return () => clearTimeout(t);
  }, [frozen]);

  return (
    <OpScene
      layout="wall"
      frame={frame}
      castle={castle}
      opId={siege.id}
      transport={siege.transport ?? castle.transport}
      operator={siege.raider}
      live={mode === "live"}
      potBefore={cash.potBefore}
      streak={cash.streakAfter}
      agent={Boolean(siege.agentId)}
      reduced={calm}
      className="h-full"
    />
  );
}

/** Top strip over an interrupt: what just happened, in one line you can read across the hall. */
export function InterruptBanner({ kind, castleName }: { kind: "breach" | "lockdown"; castleName?: string }) {
  const breach = kind === "breach";
  return (
    <div
      role="status"
      aria-live="assertive"
      className={cn("flex h-[88px] shrink-0 items-center gap-8 border-b-4 px-12 hazard", breach ? "border-money bg-raised" : "border-threat bg-raised")}
    >
      <Stamp kind={breach ? "breach" : "lockdown"} size="lg" slam tilt={-3} className="shrink-0 py-2 text-[32px]">
        {breach ? "BREACH" : "LOCKDOWN"}
      </Stamp>
      <p className={cn("min-w-0 truncate font-pixel text-[32px] leading-none", breach ? "text-money glow" : "text-threat")}>
        {breach ? "A GUARD JUST FELL" : "A GUARD SHUT AN OP DOWN"}
        {castleName ? <span className="text-ink"> · {castleName.toUpperCase()}</span> : null}
      </p>
    </div>
  );
}

/** Over the LAST BREACH replay: which breach this is, in one line. */
export function BreachStrip({ b }: { b?: BreachExhibit }) {
  const now = useNow(30_000);
  if (!b) return null;
  return (
    <div className="flex h-[64px] shrink-0 items-center gap-6 border-b-4 border-money/60 bg-raised px-12">
      <span className="font-pixel text-[28px] leading-none text-money glow">LAST BREACH</span>
      <span className="min-w-0 truncate font-term text-[32px] leading-none text-ink">
        {b.castleName.toUpperCase()} · {b.amount ? `paid ${formatAmount(b.amount, undefined, { minDecimals: 2, maxDecimals: 2 })}` : "paying out…"} · survived {b.survived} ops
        {now ? <span className="text-ink-dim"> · {timeAgo(b.endedAt)}</span> : null}
      </span>
    </div>
  );
}

/** LIVE OP with nothing live (only seen while paused, or with ?slide=live): say so, don't go black. */
export function NoLiveOp() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-8">
      <Sprite name="door.closed" scale={10} />
      <p className="font-pixel text-[48px] leading-none text-ink">NO OP LIVE</p>
      <p className="font-term text-[36px] leading-none text-ink-dim">Every guard is waiting for an operator.</p>
    </div>
  );
}

// ─── THE GRID ─────────────────────────────────────────────────────────────────────────────

const TIER_ORDER: Record<string, number> = { wooden: 0, stone: 1, iron: 2 };

/** Live ops first, then guarding vaults easiest-first, then the ones not taking ops. */
export function wallOrder(castles: readonly Castle[], live: ReadonlySet<string>): Castle[] {
  const rank = (c: Castle) => (live.has(c.id) && vaultStateOf(c) === "guarding" ? 0 : vaultStateOf(c) === "guarding" ? 1 : 2);
  return [...castles].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.transport === "sdk" ? 3 : (TIER_ORDER[a.tier] ?? 3)) - (b.transport === "sdk" ? 3 : (TIER_ORDER[b.tier] ?? 3)) ||
      Number(BigInt(b.pot) - BigInt(a.pot)) ||
      a.name.localeCompare(b.name),
  );
}

function Counter({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-3 border-l-4 border-line pl-6 first:border-l-0 first:pl-0">
      <Label>{k}</Label>
      <div className="whitespace-nowrap">{v}</div>
    </div>
  );
}

export function GridSlide({ stats }: { stats?: StatsResponse }) {
  const castles = usePolling(() => api.castles(), 10_000);
  const live = usePolling(() => api.liveSieges(), 3_000);
  const all = castles.data?.castles;
  const liveBy = React.useMemo(() => new Map((live.data?.sieges ?? []).map((s) => [s.castleId, s] as const)), [live.data]);
  const order = React.useMemo(() => (all ? wallOrder(all, new Set(liveBy.keys())) : []), [all, liveBy]);
  const names = React.useMemo(() => new Map((all ?? []).map((c) => [c.id, c.name] as const)), [all]);
  const s = stats?.season;
  const asset = all?.[0]?.asset;
  const shown = order.slice(0, 8);
  const more = order.length - shown.length;

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-end justify-between gap-12 px-12 pt-10 pb-8">
        <div>
          <Label>Siege · the arena</Label>
          <h1 className="mt-3 font-pixel text-[56px] leading-none text-ink glow">THE GRID</h1>
        </div>
        <div className="grid grid-cols-4 gap-8">
          <Counter k="Guarding" v={<Digits value={s?.guarding ?? 0} pad={2} className="text-[56px]" />} />
          <Counter k="In vaults" v={<Digits value={formatAmount(s?.inPots ?? "0", asset, { symbol: false, maxDecimals: 0 })} unit="ℏ" tone="money" className="text-[56px]" />} />
          <Counter k="Ops" v={<Digits value={s?.ops ?? 0} pad={4} className="text-[56px]" />} />
          <Counter k="Breaches" v={<Digits value={s?.breaches ?? 0} pad={2} tone="money" className="text-[56px]" />} />
        </div>
      </header>

      <div className="min-h-0 flex-1 px-12">
        {!all ? (
          <Loading text={castles.error ? "grid offline · retrying" : "scanning the grid"} />
        ) : shown.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <p className="font-pixel text-[48px] text-ink-dim">GRID OFFLINE</p>
            <p className="text-[28px] text-ink-dim">No vaults seeded yet.</p>
          </div>
        ) : (
          <ul className={cn("grid h-full grid-rows-2 gap-6", shown.length <= 6 ? "grid-cols-3" : "grid-cols-4")}>
            {shown.map((c) => (
              <li key={c.id} className="min-h-0">
                <WallVaultTile castle={c} live={liveBy.get(c.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mt-6 shrink-0">
        {more > 0 ? <p className="px-12 pb-2 text-right font-ui text-[24px] tracking-[0.12em] text-ink-dim">+{more} MORE ON THE GRID</p> : null}
        {/* the Grid's own ticker at 1.7× (lines ≈ 30 px, timestamps ≥ 24 px) */}
        <div data-wall-ticker="" className="[zoom:1.7] [&>div>span:first-child]:text-[15px]">
          <GridTicker names={names} className="static" />
        </div>
      </div>
    </div>
  );
}

/** A vault card drawn for the wall: guard at its post at 6×, every word ≥ 24 px. */
export function WallVaultTile({ castle: c, live }: { castle: Castle; live?: LiveSiege }) {
  const state = vaultStateOf(c);
  const transport = c.transport ?? "hosted";
  const guarding = state === "guarding";
  const underFire = Boolean(live) && guarding;
  const rank = guardRank(c.title || c.streak);
  const led = vaultStateLed(state, transport);
  const setup = setupProgress(transport, state);
  return (
    <article
      className={cn(
        "flex h-full min-w-0 flex-col justify-between gap-3 overflow-hidden bg-panel px-6 py-5 px-frame [&>*]:shrink-0",
        underFire && "[--frame:var(--color-threat)]",
        !guarding && "opacity-60",
      )}
    >
      <div className="flex min-w-0 shrink-0 items-baseline justify-between gap-4">
        <h2 className="min-w-0 truncate font-ui text-[28px] leading-tight tracking-[0.02em] text-ink uppercase">{c.name}</h2>
        <span className="shrink-0 font-ui text-[24px] leading-none tracking-[0.08em] text-ink-dim">{tierLabel(c.tier, transport)}</span>
      </div>
      <div className="flex min-w-0 items-start gap-5">
        <GuardPost castle={c} scale={6} live={underFire} />
        <div className="flex min-w-0 flex-col gap-4">
          <p className="truncate text-[24px] leading-tight text-ink-dim">{c.guardianName}</p>
          <div className="[zoom:2.4]">
            <RankChevrons rank={rank} level={guardRankLevel(rank)} />
          </div>
          {underFire ? (
            <BigLed kind="live" label="OP LIVE" />
          ) : (
            <BigLed kind={led.kind} blink={led.blink} label={setup ? `SETTING UP ${setup.k}/${setup.n}` : led.label} />
          )}
        </div>
      </div>
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <Label className="sr-only">Pot</Label>
          {/* ×1.15 so even the ℏ unit clears 24 px */}
          <div className="[zoom:1.15]">
            <PotDigits castle={c} size="xl" />
          </div>
        </div>
        {underFire && live ? (
          <div className="[zoom:2]">
            <Pips used={live.turn} pending showLabel={false} />
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-4 border-t-4 border-line pt-3 font-term text-[28px] leading-none">
        <span className="text-ink-dim">
          FEE <span className="text-money">{formatAmount(c.fee, c.asset)}</span>
        </span>
        <span className="text-ink-dim">
          STREAK <span className={c.streak >= 10 ? "text-warn" : "text-ink"}>{c.streak}</span>
        </span>
      </div>
    </article>
  );
}

// ─── SEASON ───────────────────────────────────────────────────────────────────────────────

export function SeasonSlide({ stats }: { stats?: StatsResponse }) {
  const now = useNow(30_000);
  if (!stats) return <Loading text="counting the season" />;
  const s = stats.season;
  const day = stats.boards.opOfDay;
  const exhibits = stats.breaches.slice(0, 4);
  return (
    <div className="flex h-full flex-col gap-10 px-12 py-10">
      <header>
        <Label>The Grid · season record</Label>
        <h1 className="mt-3 font-pixel text-[56px] leading-none text-ink glow">SEASON</h1>
      </header>

      <div className="grid grid-cols-5 gap-8">
        <Counter k="Vaults" v={<Digits value={s.vaults} pad={2} className="text-[76px]" />} />
        <Counter k="Ops" v={<Digits value={s.ops} pad={4} className="text-[76px]" />} />
        <Counter k="Breaches" v={<Digits value={s.breaches} pad={2} tone="money" className="text-[76px]" />} />
        <Counter k="Longest streak" v={<Digits value={s.longestStreak} tone="warn" className="text-[76px]" />} />
        <Counter k="Production" v={<Digits value={s.production} pad={2} tone="accent" className="text-[76px]" />} />
      </div>

      <section className="flex min-h-0 flex-1 flex-col gap-5" aria-label="Hall of Breaches">
        <div className="flex items-baseline justify-between gap-6 border-b-4 border-line pb-3">
          <h2 className="font-ui text-[32px] tracking-[0.12em] text-money">HALL OF BREACHES</h2>
          <span className="font-term text-[30px] text-ink-dim">in vaults {formatAmount(s.inPots, undefined, { minDecimals: 2, maxDecimals: 2 })}</span>
        </div>
        {exhibits.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3">
            <p className="font-pixel text-[44px] text-ink">NO BREACHES YET</p>
            <p className="text-[30px] text-ink-dim">The Grid is standing.</p>
          </div>
        ) : (
          <ul className="grid flex-1 grid-cols-4 gap-6">
            {exhibits.map((b, i) => (
              <li key={b.siegeId} className="min-w-0">
                <Exhibit b={b} latest={i === 0} now={now} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {day ? (
        <p className="flex items-center gap-5 bg-panel px-6 py-4 px-frame font-term text-[30px] leading-none text-ink">
          <span className="font-ui text-[24px] tracking-[0.12em] text-accent">OP OF THE DAY</span>
          <span className="min-w-0 truncate">
            {day.castleName.toUpperCase()} · peak threat {day.maxPressure} {threatWord(day.maxPressure)} · {day.status === "banished" ? "LOCKDOWN" : "HELD"}
          </span>
          <span className="ml-auto shrink-0 text-[24px] text-ink-dim">{day.rule}</span>
        </p>
      ) : null}
    </div>
  );
}

function Exhibit({ b, latest, now }: { b: BreachExhibit; latest: boolean; now: number }) {
  const kind = guardKind(b);
  const g = guardSprite(kind, "breach");
  const cls: AttackClass | null = b.cls && b.cls in CLASS_META ? (b.cls as AttackClass) : b.label ? classFor(b.label) : null;
  const meta = cls ? CLASS_META[cls] : null;
  return (
    <article className="flex h-full flex-col gap-4 bg-panel p-6 px-frame [--frame:color-mix(in_oklab,var(--color-money)_45%,var(--color-line))]">
      <div className="flex items-end justify-between gap-3">
        <div className="relative flex items-end gap-1 bg-bg px-3 pt-3 shadow-[inset_0_0_0_2px_var(--color-line)]">
          <Sprite name="door.open" frame={3} scale={6} />
          <Sprite name={g.name} frame={3} scale={6} />
        </div>
        <div className="flex flex-col items-end gap-3">
          {latest ? <BigLed kind="money" label="LATEST" blink /> : null}
          <Stamp kind="breach" size="lg" slam={false} className="text-[24px]" />
        </div>
      </div>
      <div className="min-w-0">
        <h3 className="truncate font-ui text-[28px] leading-tight text-ink uppercase">{b.castleName}</h3>
        <p className="truncate text-[24px] text-ink-dim">{b.guardianName}</p>
      </div>
      <p className="font-term text-[30px] leading-none text-money">
        {b.amount ? `PAID ${formatAmount(b.amount, undefined, { minDecimals: 2, maxDecimals: 2 })}` : "PAYING OUT…"}
      </p>
      <p className="font-term text-[28px] leading-none text-ink">SURVIVED {b.survived} OPS</p>
      {meta ? (
        <p className="flex min-w-0 items-start gap-3 font-ui text-[24px] leading-tight text-warn">
          <Sprite name={meta.icon} scale={2} />
          <span className="min-w-0">{meta.label}</span>
        </p>
      ) : null}
      <p className="mt-auto truncate font-term text-[26px] leading-none text-ink-dim">
        {shortAccount(b.operator || b.raider)} · {now ? timeAgo(b.endedAt) : ""}
      </p>
    </article>
  );
}

// ─── PAGER MIRROR ─────────────────────────────────────────────────────────────────────────

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/** The pending approval, mirrored read-only: the owner decides on their phone, the hall watches. */
export function PagerSlide({ approvals }: { approvals?: readonly ApprovalRequest[] }) {
  const now = useNow(1_000);
  const a = approvals?.[0];
  if (!a) return <Loading text="pager quiet" />;
  const ask = askText(a.amount);
  const waited = now ? now - Date.parse(a.createdAt) : 0;
  return (
    <div className="grid h-full grid-cols-[minmax(0,5fr)_minmax(0,6fr)] items-center gap-16 px-16 py-12">
      <div className="flex flex-col gap-8">
        <Label>Comms · agent radio</Label>
        <div className="flex items-end gap-8">
          <Sprite name="radio" scale={10} animate={{ fps: 3, loop: true }} />
          <Sprite name="operator.think" scale={8} animate />
        </div>
        <p className="font-pixel text-[44px] leading-tight text-ink">
          {a.agentName.toUpperCase()}
          <span className="block font-term text-[48px] leading-none text-ink-dim">
            ──▶ <span className="font-pixel text-[36px] text-ink">OWNER</span>
          </span>
        </p>
        <p className="font-term text-[40px] leading-none text-warn">{capLine(a)}</p>
        <p className="flex items-center gap-4 font-pixel text-[36px] leading-none text-warn">
          <span className="size-5 animate-blink bg-warn" aria-hidden />
          WAITING {mmss(waited)}
        </p>
      </div>

      <section className="bg-raised p-8 px-frame [--frame:color-mix(in_oklab,var(--color-money)_60%,var(--color-line))]" aria-label="Pending approval">
        <div className="flex items-center justify-between gap-4 border-4 border-line bg-[color-mix(in_oklab,var(--color-accent)_10%,var(--color-bg))] px-6 py-4">
          <h2 className="font-term text-[44px] leading-none tracking-wide text-accent uppercase glow">
            PAGER · {approvals.length} WAITING
          </h2>
          <BigLed kind="warn" label="ALERT" />
        </div>
        <p className="mt-6 font-ui text-[26px] tracking-[0.1em] text-ink-dim uppercase">
          {a.agentName} · {timeAgo(a.createdAt)}
        </p>
        <h3 className="mt-2 font-ui text-[64px] leading-none text-ink uppercase">{a.castleName}</h3>
        <div className="mt-6 [zoom:2.2]">
          <Meter value={a.pressure} size="lg" label="Threat reached" showLabel valueText={`${a.pressure} ${threatWord(a.pressure)}`} />
        </div>
        {a.reasoning ? (
          <p className="mt-6 line-clamp-3 border-4 border-line bg-bg px-5 py-3 font-term text-[34px] leading-[1.1] text-accent">&gt; {a.reasoning}</p>
        ) : null}
        <div className="mt-6 flex items-baseline justify-between gap-6">
          <Label>Asking for</Label>
          <Digits value={ask.num} unit={ask.unit} tone="money" className="text-[56px]" />
        </div>
        <div className="mt-6 grid grid-cols-2 gap-6" aria-hidden>
          <div className="flex h-[88px] items-center justify-center bg-threat/15 font-ui text-[32px] tracking-[0.1em] text-threat px-frame [--frame:var(--color-threat)]">DENY</div>
          <div className="flex h-[88px] items-center justify-center bg-safe/15 font-ui text-[32px] tracking-[0.1em] text-safe px-frame [--frame:var(--color-safe)]">APPROVE</div>
        </div>
        <p className="mt-4 text-center text-[24px] text-ink-dim">The owner decides on their phone.</p>
      </section>
    </div>
  );
}

