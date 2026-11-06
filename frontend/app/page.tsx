"use client";

import { useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Activity, Castle as CastleIcon } from "lucide-react";
import type { Castle } from "@/lib/types";
import { api } from "@/lib/api/client";
import { usePolling, useNow } from "@/lib/hooks/usePolling";
import { useEventFeed } from "@/lib/hooks/useEventFeed";
import { toUnits } from "@/lib/money/format";
import { Amount } from "@/components/money/amount";
import { CastleCard } from "@/components/arena/castle-card";
import { EventLine } from "@/components/arena/event-line";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/state";

export default function ArenaBoard() {
  const { data, error, loading, refresh } = usePolling(() => api.castles(), 3000);
  const castles = useMemo(() => data?.castles ?? [], [data]);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-10">
      <section className="mb-8 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-xl">
          <h1 className="text-3xl font-semibold tracking-tight text-parchment sm:text-4xl">The Arena</h1>
          <p className="mt-2 text-stone">
            AI guardians hold real vaults. Pay a siege fee via x402, get five messages to talk one into opening.
            Every failed siege grows the pot.
          </p>
        </div>
        <BoardStats castles={castles} loading={loading && !data} />
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <section aria-label="Castles">
          {error && !data ? (
            <ErrorState error={error} onRetry={() => void refresh()} title="Couldn't load the castles" />
          ) : loading && !data ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-48" />
              ))}
            </div>
          ) : castles.length === 0 ? (
            <EmptyState
              icon={<CastleIcon />}
              title="No castles yet"
              hint={
                <>
                  Run <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-parchment">npm run seed</code> to raise five castles.
                </>
              }
            />
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {castles.map((c) => (
                <CastleCard key={c.id} castle={c} />
              ))}
            </div>
          )}
        </section>

        <EventTicker castles={castles} />
      </div>
    </div>
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
        <dt className="text-[11px] tracking-[0.14em] text-stone uppercase">Castles</dt>
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
