"use client";

import { useMemo } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Activity, Castle as CastleIcon } from "lucide-react";
import type { Castle, StoredSiegeEvent } from "@/lib/types";
import { api } from "@/lib/api/client";
import { usePolling, useNow } from "@/lib/hooks/usePolling";
import { useEventFeed } from "@/lib/hooks/useEventFeed";
import { timeAgo, toUnits } from "@/lib/money/format";
import { closeReasonText, vaultStateOf } from "@/lib/money/vault";
import { Amount } from "@/components/money/amount";
import { CastleCard } from "@/components/arena/castle-card";
import { EventLine } from "@/components/arena/event-line";
import { TransportBadge, VaultSetupSteps, VaultStateBadge } from "@/components/arena/vault-state";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/state";

export default function ArenaBoard() {
  const { data, error, loading, refresh } = usePolling(() => api.castles(), 3000);
  const castles = useMemo(() => data?.castles ?? [], [data]);
  // Only guarding castles take sieges; everything else goes in the muted list below the grid.
  const guarding = useMemo(() => castles.filter((c) => vaultStateOf(c) === "guarding"), [castles]);
  const resting = useMemo(() => castles.filter((c) => vaultStateOf(c) !== "guarding"), [castles]);
  const feed = useEventFeed({ intervalMs: 2000, limit: 60, tail: true });

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
        <BoardStats castles={castles} guarding={guarding} loading={loading && !data} />
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
            <>
              {guarding.length === 0 ? (
                <EmptyState
                  icon={<CastleIcon />}
                  title="No castle is taking sieges right now"
                  hint="Guardians below are offline, still being set up, or their vaults have ended."
                />
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {guarding.map((c) => (
                    <CastleCard key={c.id} castle={c} />
                  ))}
                </div>
              )}
              {resting.length > 0 ? <NotTakingSieges castles={resting} events={feed.events} /> : null}
            </>
          )}
        </section>

        <EventTicker castles={castles} feed={feed} />
      </div>
    </div>
  );
}

function BoardStats({ castles, guarding, loading }: { castles: Castle[]; guarding: Castle[]; loading: boolean }) {
  const totalPot = guarding.reduce((sum, c) => sum + toUnits(c.pot), BigInt(0));
  const sieges = castles.reduce((n, c) => n + (c.siegeCount ?? 0), 0);
  const breaks = castles.filter((c) => c.status === "broken").length;
  const asset = castles[0]?.asset;
  const stat = "flex flex-col gap-0.5 rounded-xl border border-arena-line bg-arena-panel/70 px-4 py-3";
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:min-w-[560px]" aria-busy={loading}>
      <div className={stat}>
        <dt className="text-[11px] tracking-[0.14em] text-stone uppercase">Guarding</dt>
        <dd className="tabular text-xl font-semibold">
          {guarding.length}
          {castles.length > guarding.length ? <span className="text-sm font-normal text-stone"> / {castles.length}</span> : null}
        </dd>
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

/** Last break siege per castle, from the live feed (only recent ones are known). */
function breakSieges(events: StoredSiegeEvent[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of events) if (e.type === "end" && e.castleId && e.siegeId && e.payload?.status === "broken" && !e.payload?.free) m.set(e.castleId, e.siegeId);
  return m;
}

/** Compact, muted list of castles that exist but aren't taking sieges. */
function NotTakingSieges({ castles, events }: { castles: Castle[]; events: StoredSiegeEvent[] }) {
  const now = useNow(15000);
  const breaks = useMemo(() => breakSieges(events), [events]);
  return (
    <section aria-label="Not taking sieges" className="mt-8">
      <h2 className="mb-2 text-[11px] tracking-[0.14em] text-stone uppercase">Not taking sieges</h2>
      <ul className="divide-y divide-arena-line rounded-2xl border border-arena-line bg-arena-panel/40">
        {castles.map((c) => {
          const state = vaultStateOf(c);
          const breakId = state === "broken" ? breaks.get(c.id) : undefined;
          return (
            <li key={c.id} className={state === "dormant" ? "opacity-60 grayscale" : undefined}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                <Link href={`/castle/${c.id}`} className="min-w-0 truncate font-medium text-parchment/80 hover:text-parchment">
                  {c.name}
                </Link>
                <VaultStateBadge state={state} />
                <TransportBadge transport={c.transport ?? "hosted"} className="hidden sm:inline-flex" />
                <span className="min-w-0 flex-1 truncate text-xs text-stone">
                  {state === "dormant" ? (
                    c.lastSeenAt && now ? `guardian offline · last seen ${timeAgo(c.lastSeenAt, now)}` : "guardian offline"
                  ) : state === "broken" ? (
                    <Link href={breakId ? `/siege/${breakId}` : `/castle/${c.id}`} className="underline decoration-arena-line underline-offset-4 hover:text-parchment">
                      {breakId ? "see the break" : "see the castle"}
                    </Link>
                  ) : state === "closed" ? (
                    closeReasonText(c.vaultStateReason)
                  ) : (
                    <VaultSetupSteps transport={c.transport ?? "hosted"} state={state} />
                  )}
                </span>
                <Amount amount={c.pot} asset={c.asset} size="xs" animate={false} className="text-stone" />
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function EventTicker({ castles, feed }: { castles: Castle[]; feed: ReturnType<typeof useEventFeed> }) {
  const { events, error, ready } = feed;
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
