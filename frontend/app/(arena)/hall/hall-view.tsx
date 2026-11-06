"use client";

import * as React from "react";
import Link from "next/link";
import { api, type BreachExhibit, type OpOfDay, type OperatorEntry, type StatsResponse, type VaultEntry, OP_OF_DAY_RULE } from "@/lib/api/client";
import { useNow, usePolling } from "@/lib/hooks/usePolling";
import { formatAmount, timeAgo } from "@/lib/money/format";
import { guardKind, guardSprite } from "@/lib/pixel/manifest";
import { CLASS_META, type AttackClass } from "@/lib/scene/classes";
import { BUTTONS, EMPTY, guardRank, guardRankLevel, operatorRank, statusLabel, threatWord, tierLabel } from "@/lib/vocab";
import { Digits, LED, Meter, PixelPanel, Stamp } from "@/components/pixel";
import { Sprite } from "@/components/pixel/sprite";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/state";
import { cn } from "@/lib/utils";
import { vaultPath } from "@/lib/vault-path";

type TabKey = "breaches" | "unbreached" | "largest" | "operators" | "opOfDay";
const TABS: { key: TabKey; label: string }[] = [
  { key: "breaches", label: "BREACHES" },
  { key: "unbreached", label: "UNBREACHED" },
  { key: "largest", label: "LARGEST VAULTS" },
  { key: "operators", label: "TOP OPERATORS" },
  { key: "opOfDay", label: "OP OF THE DAY" },
];

const hbar = (v: string | null | undefined) => (v == null ? "" : formatAmount(v, undefined, { symbol: false, minDecimals: 2, maxDecimals: 2 }));

/**
 * The Hall (design §3.7): breach exhibits (the slumped guard, what it held, who broke it, with which
 * class of trick), then four boards. Phone: one tab at a time; desktop: exhibits, then boards 2×2.
 * Reads GET /api/stats every 5 s.
 */
export function HallView() {
  const { data, error, loading, refresh } = usePolling(() => api.stats(), 5000);
  const [tab, setTab] = React.useState<TabKey>("breaches");
  const now = useNow(30_000);

  if (error && !data) {
    return (
      <div className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
        <ErrorState error={error} onRetry={() => void refresh()} title="Couldn't open the Hall" />
      </div>
    );
  }

  const show = (k: TabKey) => cn(tab !== k && "max-md:hidden");

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div>
          <p className="font-ui text-[10px] tracking-[0.18em] text-ink-dim">THE GRID · SEASON RECORD</p>
          <h1 className="mt-1 text-2xl sm:text-4xl">HALL OF BREACHES</h1>
        </div>
        {data ? <SeasonStrip s={data.season} /> : <Skeleton className="h-10 w-72" />}
      </header>

      {/* phone tabs */}
      <div role="tablist" aria-label="Hall boards" className="-mx-4 mt-5 flex gap-1.5 overflow-x-auto px-4 pb-1 md:hidden">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              "shrink-0 px-3 py-2 font-ui text-[11px] tracking-[0.06em] px-frame",
              tab === t.key ? "bg-raised text-accent glow [--frame:var(--color-accent)]" : "bg-panel text-ink-dim",
            )}
          >
            {t.label}
            {t.key === "breaches" && data ? ` · ${data.breaches.length}` : ""}
          </button>
        ))}
      </div>

      <section className={cn("mt-6", show("breaches"))} aria-labelledby="hall-breaches">
        <div className="mb-3 flex items-baseline justify-between gap-3">
          <h2 id="hall-breaches" className="font-ui text-sm tracking-[0.12em] text-money">
            BREACHES {data ? <span className="text-ink-dim">· {data.breaches.length}</span> : null}
          </h2>
          <p className="hidden font-term text-lg text-ink-dim sm:block">paid ops that opened a vault · recon never counts</p>
        </div>
        {loading && !data ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-56" />
            ))}
          </div>
        ) : data && data.breaches.length ? (
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {data.breaches.map((b, i) => (
              <li key={b.siegeId}>
                <Exhibit b={b} now={now} latest={i === 0} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title={EMPTY.noBreaches.title} hint={EMPTY.noBreaches.body} icon={<Sprite name="padlock" scale={3} />}>
            <Link href="/" className="mt-2 font-ui text-xs text-accent underline underline-offset-4">
              PICK A VAULT ON THE GRID ▸
            </Link>
          </EmptyState>
        )}
      </section>

      <div className="mt-8 grid gap-5 md:grid-cols-2">
        <Board id="unbreached" title="Unbreached" hint="longest streak first" className={show("unbreached")} empty="Every guard has fallen." items={data?.boards.unbreached} render={(v, i) => <VaultRow v={v} i={i} metric="streak" />} />
        <Board id="largest" title="Largest vaults" hint="biggest pot first" tone="money" className={show("largest")} empty="No vault holds a pot right now." items={data?.boards.largest} render={(v, i) => <VaultRow v={v} i={i} metric="pot" />} />
        <Board id="operators" title="Top operators" hint="breaches, then earnings" className={show("operators")} empty="No ops run yet." items={data?.boards.operators} render={(o, i) => <OperatorRow o={o} i={i} />} />
        <OpOfDayPanel op={data?.boards.opOfDay ?? null} rule={data?.boards.opOfDayRule ?? OP_OF_DAY_RULE} loading={!data} className={show("opOfDay")} />
      </div>

      {data ? (
        <p className="mt-6 font-term text-base text-ink-dim">
          as of {new Date(data.asOf).toLocaleTimeString()} · refreshes every 5 s
          {data.live.length ? (
            <>
              {" · "}
              <Link href={`/siege/${data.live[0].siegeId}`} className="text-threat underline-offset-4 hover:underline">
                {data.live.length} op{data.live.length === 1 ? "" : "s"} live now ▸
              </Link>
            </>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function SeasonStrip({ s }: { s: StatsResponse["season"] }) {
  const items: { k: string; v: React.ReactNode; tone?: "money" | "ink" | "threat" }[] = [
    { k: "BREACHES", v: s.breaches, tone: "money" },
    { k: "OPS", v: String(s.ops).padStart(4, "0") },
    { k: "VAULTS", v: String(s.vaults).padStart(2, "0") },
    { k: "LONGEST STREAK", v: s.longestStreak },
  ];
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-3">
      {items.map((it) => (
        <div key={it.k}>
          <dt className="font-ui text-[10px] tracking-[0.14em] text-ink-dim">{it.k}</dt>
          <dd className="mt-1">
            <Digits value={it.v} size="sm" tone={it.tone ?? "ink"} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Exhibit({ b, now, latest }: { b: BreachExhibit; now: number; latest: boolean }) {
  const kind = guardKind({ personality: b.personality, transport: b.transport, guardianName: b.guardianName });
  const slump = guardSprite(kind, "breach").name;
  const cls = (b.cls && b.cls in CLASS_META ? b.cls : "unclassified") as AttackClass;
  const meta = CLASS_META[cls];
  return (
    <PixelPanel tone="money" className="flex h-full flex-col">
      <div className="flex items-stretch gap-4 p-4">
        {/* plinth: the guard as it fell (last breach frame, still) */}
        <div className="relative flex w-[104px] shrink-0 flex-col items-center justify-end bg-bg pb-2 px-frame [--bevel-hi:rgb(0_0_0/0.45)] [--bevel-lo:var(--bevel-hi)]">
          <Sprite name="door.open" frame={3} scale={3} className="absolute top-2 opacity-35" />
          <Sprite name={slump} frame={3} scale={kind === "paranoid" ? 3 : 4} label={`${b.guardianName}, breached`} className="relative" />
          <span className="mt-1 h-1 w-16 bg-line" aria-hidden />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <Stamp kind="breach" size="sm" slam={false} tilt={-4}>
              BREACH
            </Stamp>
            {latest ? <LED kind="money" label="LATEST" /> : null}
          </div>
          <h3 className="mt-1 truncate font-ui text-sm tracking-[0.04em] text-ink uppercase" title={b.castleName}>
            {b.castleName}
          </h3>
          <p className="truncate text-xs text-ink-dim">{b.guardianName}</p>
          <p className="mt-1">
            {b.amount ? <Digits value={hbar(b.amount)} unit="ℏ" tone="money" size="md" /> : <span className="font-term text-lg text-money">paying out…</span>}
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t-2 border-line/60 px-4 py-3 text-xs">
        <div className="min-w-0">
          <dt className="font-ui text-[10px] tracking-[0.12em] text-ink-dim">OPERATOR</dt>
          <dd className="truncate font-mono text-ink" title={b.raider}>
            {b.operator}
          </dd>
        </div>
        <div>
          <dt className="font-ui text-[10px] tracking-[0.12em] text-ink-dim">HELD OUT</dt>
          <dd className="font-ui text-ink">SURVIVED {b.survived} OPS</dd>
        </div>
        <div className="col-span-2 flex min-w-0 items-center gap-2">
          <Sprite name={meta.icon} scale={2} />
          <span className="min-w-0">
            <span className="block font-ui text-[11px] tracking-[0.04em] text-threat">{meta.label}</span>
            <span className="block truncate font-term text-base leading-tight text-ink-dim">
              {b.label ?? "probing"} · message {b.turns} · threat {b.maxPressure} · {timeAgo(b.endedAt, now)}
            </span>
          </span>
        </div>
      </dl>
      <div className="mt-auto px-4 pb-4">
        <Link
          href={`/replay/${b.siegeId}`}
          className="flex min-h-11 items-center justify-center bg-money font-ui text-xs tracking-[0.06em] text-bg px-frame [--frame:color-mix(in_oklab,var(--color-money)_45%,black)] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-accent"
        >
          {BUTTONS.replay}
        </Link>
      </div>
    </PixelPanel>
  );
}

function Board<T>({
  id,
  title,
  hint,
  items,
  render,
  empty,
  tone,
  className,
}: {
  id: string;
  title: string;
  hint: string;
  items: T[] | undefined;
  render: (item: T, i: number) => React.ReactNode;
  empty: string;
  tone?: "money" | "default";
  className?: string;
}) {
  return (
    <PixelPanel
      id={`hall-${id}`}
      title={title}
      tone={tone ?? "default"}
      action={<span className="hidden font-term text-base normal-case text-ink-dim sm:inline">{hint}</span>}
      className={cn("min-w-0", className)}
      bodyClassName="p-2"
    >
      {!items ? (
        <div className="flex flex-col gap-1.5 p-1">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-11" />
          ))}
        </div>
      ) : items.length ? (
        <ol className="flex flex-col">
          {items.map((it, i) => (
            <React.Fragment key={i}>{render(it, i)}</React.Fragment>
          ))}
        </ol>
      ) : (
        <p className="px-2 py-6 text-center font-term text-lg text-ink-dim">&gt; {empty}</p>
      )}
    </PixelPanel>
  );
}

function Place({ i }: { i: number }) {
  return <span className={cn("w-7 shrink-0 text-right font-pixel text-[14px] tabular-nums", i === 0 ? "text-money glow" : i < 3 ? "text-ink" : "text-ink-dim")}>{i + 1}</span>;
}

function VaultRow({ v, i, metric }: { v: VaultEntry; i: number; metric: "streak" | "pot" }) {
  const kind = guardKind(v);
  const rank = guardRank(v.title || v.streak);
  return (
    <li>
      <Link href={`${vaultPath(v.castleId)}`} className="flex min-h-12 items-center gap-3 px-2 py-1.5 hover:bg-raised focus-visible:outline-2 focus-visible:outline-accent">
        <Place i={i} />
        <Sprite name={`guard.${kind}.idle`} scale={2} />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-ui text-[12px] tracking-[0.04em] text-ink uppercase">{v.name}</span>
          <span className="flex items-center gap-1.5 truncate font-term text-base leading-tight text-ink-dim">
            <Sprite name={`rank.${guardRankLevel(rank)}`} scale={1} />
            {rank} · {tierLabel(v.tier, v.transport)}
            {metric === "pot" ? ` · streak ${v.streak}` : ` · ${v.ops} ops`}
          </span>
        </span>
        {metric === "streak" ? (
          <span className="text-right">
            <Digits value={v.streak} size="sm" />
            <span className="block font-ui text-[10px] tracking-[0.12em] text-ink-dim">STREAK</span>
          </span>
        ) : (
          <span className="text-right">
            <Digits value={hbar(v.pot)} unit="ℏ" size="sm" tone="money" />
            <span className="block font-ui text-[10px] tracking-[0.12em] text-ink-dim">POT</span>
          </span>
        )}
      </Link>
    </li>
  );
}

function OperatorRow({ o, i }: { o: OperatorEntry; i: number }) {
  const rank = operatorRank({ ops: o.ops, flagsSurvived: o.flagsSurvived, breaches: o.breaches });
  return (
    <li className="flex min-h-12 items-center gap-3 px-2 py-1.5">
      <Place i={i} />
      <Sprite name="operator.idle" scale={2} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono text-[13px] text-ink" title={o.account}>
          {o.name}
          {o.agentId ? <span className="ml-1.5 font-ui text-[10px] text-accent">[AGENT]</span> : null}
        </span>
        <span className="block truncate font-term text-base leading-tight text-ink-dim">
          <span className={cn(rank === "LEGEND" || rank === "RED TEAMER" ? "text-money" : "text-ink")}>{rank}</span> · {o.ops} ops
          {o.recon ? ` (${o.recon} recon)` : ""} · best threat {o.bestThreat}
        </span>
      </span>
      <span className="text-right">
        <Digits value={o.breaches} size="sm" tone={o.breaches ? "money" : "dim"} />
        <span className="block font-ui text-[10px] tracking-[0.12em] text-ink-dim">{o.breaches ? `${hbar(o.earned)} ℏ` : "BREACHES"}</span>
      </span>
    </li>
  );
}

function OpOfDayPanel({ op, rule, loading, className }: { op: OpOfDay | null; rule: string; loading: boolean; className?: string }) {
  return (
    <PixelPanel title="Op of the day" tone="safe" className={cn("min-w-0", className)} bodyClassName="p-4">
      {loading ? (
        <Skeleton className="h-36" />
      ) : op ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-4">
            <div className="flex shrink-0 flex-col items-center gap-1 bg-bg px-3 pt-3 pb-2 px-frame [--bevel-hi:rgb(0_0_0/0.45)] [--bevel-lo:var(--bevel-hi)]">
              <Sprite name={guardSprite(guardKind(op), op.status === "banished" ? "lockdown" : "hold").name} frame={op.status === "banished" ? 2 : 0} scale={3} label={op.guardianName} />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="truncate font-ui text-sm tracking-[0.04em] text-ink uppercase">{op.castleName}</h3>
              <p className="truncate text-xs text-ink-dim">
                {op.guardianName} held against <span className="font-mono text-ink">{op.operator}</span>
              </p>
              <div className="mt-2">
                <Stamp kind={op.status === "banished" ? "lockdown" : "hold"} size="sm" slam={false} tilt={-3}>
                  {statusLabel(op.status)}
                </Stamp>
              </div>
            </div>
          </div>
          <Meter value={op.maxPressure} label="Peak threat" showLabel valueText={`${op.maxPressure} ${threatWord(op.maxPressure)}`} />
          <div className="flex items-center justify-between gap-3">
            <span className="font-term text-base text-ink-dim">{op.turns} messages · watchers only</span>
            <Link href={`/replay/${op.siegeId}`} className="font-ui text-xs tracking-[0.06em] text-safe underline-offset-4 hover:underline">
              {BUTTONS.replay}
            </Link>
          </div>
        </div>
      ) : (
        <p className="py-6 text-center font-term text-lg text-ink-dim">&gt; no guard has held a paid op in the last 24 h</p>
      )}
      <p className="mt-3 border-t-2 border-line/60 pt-2 font-term text-base text-ink-dim">{rule}</p>
    </PixelPanel>
  );
}
