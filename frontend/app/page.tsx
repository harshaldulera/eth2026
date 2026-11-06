"use client";

import { Suspense, useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { Activity, Castle as CastleIcon } from "lucide-react";
import type { Castle } from "@/lib/types";
import { api, type CastleRow } from "@/lib/api/client";
import { usePolling, useNow } from "@/lib/hooks/usePolling";
import { useEventFeed } from "@/lib/hooks/useEventFeed";
import { toUnits } from "@/lib/money/format";
import { vaultStateOf } from "@/lib/money/vault";
import { Amount } from "@/components/money/amount";
import { ArkivBar } from "@/components/arena/arkiv-bar";
import { BoardFilters, paramsFromQuery, queryFromParams, type BoardQuery } from "@/components/arena/board-filters";
import { CastleCard } from "@/components/arena/castle-card";
import { EventLine } from "@/components/arena/event-line";
import { VaultStateBadge } from "@/components/arena/vault-state";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/state";

export default function ArenaBoardPage() {
  return (
    <Suspense fallback={<div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6"><Skeleton className="h-48" /></div>}>
      <ArenaBoard />
    </Suspense>
  );
}

function ArenaBoard() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = useMemo(() => queryFromParams(params), [params]);
  const setQ = useCallback(
    (next: BoardQuery) => {
      const s = paramsFromQuery(next).toString();
      router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  // The filters are the Arkiv query: only guarding castles unless "All states" is on.
  const key = paramsFromQuery(q).toString();
  const { data, error, loading, refresh } = usePolling(
    () => api.castles({ tier: q.tier, sort: q.sort, minPot: q.minPot, vaultState: q.all ? undefined : "guarding" }),
    3000,
    { key },
  );
  const live = usePolling(() => api.liveSieges(), 5000);
  const now = useNow(30_000);

  const castles = useMemo(() => data?.castles ?? [], [data]);
  const underSiege = useMemo(() => new Set((live.data?.sieges ?? []).map((s) => s.castleId)), [live.data]);
  const guarding = useMemo(() => castles.filter((c) => vaultStateOf(c) === "guarding"), [castles]);
  const resting = useMemo(() => castles.filter((c) => vaultStateOf(c) !== "guarding"), [castles]);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-10">
      <section className="mb-6 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-xl">
          <h1 className="text-3xl font-semibold tracking-tight text-parchment sm:text-4xl">The Arena</h1>
          <p className="mt-2 text-stone">
            AI guardians hold real vaults. Pay a siege fee via x402, get five messages to talk one into opening.
            Every failed siege grows the pot.
          </p>
        </div>
        <BoardStats castles={guarding} loading={loading && !data} />
      </section>

      <BoardFilters value={q} onChange={setQ} className="mb-5" />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <section aria-label="Castles" className="min-w-0">
          {error && !data ? (
            <ErrorState error={error} onRetry={() => void refresh()} title="Couldn't load the castles" />
          ) : loading && !data ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-56" />
              ))}
            </div>
          ) : castles.length === 0 ? (
            <EmptyState
              icon={<CastleIcon />}
              title={key ? "No castle matches these filters" : "No castles yet"}
              hint={
                key ? (
                  "The query ran on Arkiv and came back empty. Loosen a filter."
                ) : (
                  <>
                    Run <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-parchment">npm run seed</code> to raise five castles.
                  </>
                )
              }
            />
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {(q.all ? castles : guarding).map((c) => (
                  <CastleCard key={c.id} castle={c} arkiv={(c as CastleRow).arkiv} underSiege={underSiege.has(c.id)} now={now} />
                ))}
              </div>
              {!q.all && resting.length > 0 ? <RestingList castles={resting} /> : null}
            </>
          )}
          <ArkivBar meta={data?.arkiv} className="mt-4" />
        </section>

        <EventTicker castles={castles} />
      </div>
    </div>
  );
}

/** Castles the query returned that are not guarding (only possible in SQLite fallback). */
function RestingList({ castles }: { castles: Castle[] }) {
  return (
    <ul className="mt-4 flex flex-wrap gap-2 text-xs text-stone">
      {castles.map((c) => (
        <li key={c.id} className="inline-flex items-center gap-2 rounded-full border border-arena-line px-2.5 py-1">
          {c.name} <VaultStateBadge state={vaultStateOf(c)} />
        </li>
      ))}
    </ul>
  );
}

function BoardStats({ castles, loading }: { castles: Castle[]; loading: boolean }) {
  const totalPot = castles.reduce((sum, c) => sum + toUnits(c.pot), BigInt(0));
  const sieges = castles.reduce((n, c) => n + (c.siegeCount ?? 0), 0);
  const breaks = castles.filter((c) => c.status === "broken").length;
  const asset = castles[0]?.asset;
  const stat = "flex flex-col gap-0.5 rounded-xl border border-arena-line bg-arena-panel/70 px-4 py-3";
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:min-w-[560px]" aria-busy={loading}>
      <div className={stat}>
        <dt className="text-[11px] tracking-[0.14em] text-stone uppercase">Guarding</dt>
        <dd className="tabular text-xl font-semibold">{castles.length}</dd>
      </div>
      <div className={stat}>
        <dt className="text-[11px] tracking-[0.14em] text-stone uppercase">In pots</dt>
        <dd>
          <Amount amount={totalPot} asset={asset} size="lg" maxDecimals={2} />
        </dd>
      </div>
      <div className={stat}>
        <dt className="text-[11px] tracking-[0.14em] text-stone uppercase">Sieges</dt>
        <dd className="tabular text-xl font-semibold">{sieges}</dd>
      </div>
      <div className={stat}>
        <dt className="text-[11px] tracking-[0.14em] text-stone uppercase">Breaks</dt>
        <dd className="tabular text-xl font-semibold text-gold">{breaks}</dd>
      </div>
    </dl>
  );
}

function EventTicker({ castles }: { castles: Castle[] }) {
  const { events, error, ready } = useEventFeed({ intervalMs: 2000, limit: 60, tail: true });
  const now = useNow(5000);
  const names = useMemo(() => new Map(castles.map((c) => [c.id, c.name])), [castles]);
  const shown = useMemo(
    () => [...events].reverse().filter((e) => e.type !== "message" && (e.type !== "decision" || ["open", "expose"].includes(String(e.payload?.move)))).slice(0, 14),
    [events],
  );
  return (
    <Card className="h-fit lg:sticky lg:top-20">
      <CardHeader title="Live" icon={<Activity />} action={<span className="size-1.5 animate-pulse rounded-full bg-ember" aria-hidden />} />
      <CardBody className="max-h-[560px] overflow-y-auto">
        {!ready ? (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-5" />
            ))}
          </div>
        ) : error && shown.length === 0 ? (
          <p className="text-sm text-stone">Event feed unavailable — retrying…</p>
        ) : shown.length === 0 ? (
          <p className="text-sm text-stone">Quiet on the walls. Lay a siege to start the feed.</p>
        ) : (
          <ul className="space-y-3">
            <AnimatePresence initial={false}>
              {shown.map((e) => (
                <motion.li key={e.id} layout initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
                  <EventLine event={e} castleName={(id) => (id ? names.get(id) : undefined)} now={now} />
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
