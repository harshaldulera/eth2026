"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { LiveSiege } from "@/lib/api/client";
import { api } from "@/lib/api/client";
import { usePolling, useNow } from "@/lib/hooks/usePolling";
import { vaultStateOf } from "@/lib/money/vault";
import { ArkivBar } from "@/components/arena/arkiv-bar";
import { BoardFilters, paramsFromQuery, queryFromParams, type BoardQuery } from "@/components/arena/board-filters";
import { Grid } from "@/components/grid/grid";
import { NotTakingOps } from "@/components/grid/not-taking";
import { ReconBriefing } from "@/components/grid/recon-briefing";
import { SeasonStrip } from "@/components/grid/season-strip";
import { SortChips } from "@/components/grid/sort-chips";
import { applyOrder, orderFrom, sortCastles, type GridOrder } from "@/components/grid/sort";
import { GridTicker } from "@/components/grid/ticker";
import { playCue } from "@/components/pixel/sfx-link";

/** URL for the Grid with `query` + `order` (+ any other params kept as they are, e.g. recon). */
function gridUrl(pathname: string, current: URLSearchParams, query: BoardQuery, orderParam: string | null, drop: string[] = []): string {
  const p = paramsFromQuery(query);
  if (orderParam) p.set("order", orderParam);
  for (const [k, v] of current) if (!["tier", "sort", "minPot", "state", "order", ...drop].includes(k) && !p.has(k)) p.set(k, v);
  const s = p.toString();
  return s ? `${pathname}?${s}` : pathname;
}

/**
 * The Grid (`/`): season strip → sort chips + Arkiv filters → Arkiv source line → vault cards →
 * NOT TAKING OPS → bottom ticker. `?recon=1` (the QR) opens the recon briefing.
 * The filters are the Arkiv query (Sujal's): only guarding vaults unless ALL STATES is on.
 */

/** A live op older than this is treated as abandoned on the Grid (no LIVE frame). */
const ABANDONED_MS = 10 * 60 * 1000;

export function GridPage() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const q = useMemo(() => queryFromParams(params), [params]);
  const order = useMemo(() => orderFrom(q, params), [q, params]);

  const setQ = useCallback(
    (next: BoardQuery) => router.replace(gridUrl(pathname, new URLSearchParams(params), next, params.get("order")), { scroll: false }),
    [router, pathname, params],
  );
  const setOrder = useCallback(
    (o: GridOrder) => {
      const { query, orderParam } = applyOrder(q, o);
      router.replace(gridUrl(pathname, new URLSearchParams(params), query, orderParam), { scroll: false });
    },
    [router, pathname, params, q],
  );

  // The Arkiv query (filters) …
  const key = paramsFromQuery(q).toString();
  const { data, error, loading, refresh } = usePolling(
    () => api.castles({ tier: q.tier, sort: q.sort, minPot: q.minPot, vaultState: q.all ? undefined : "guarding" }),
    3000,
    { key },
  );
  // … every vault (season counters, NOT TAKING OPS, ticker names, the recon target) …
  // (3 s like the main query: a vault walking through setup reaches the Grid within a beat)
  const every = usePolling(() => api.castles(), 3000);
  // … and the ops running right now.
  const live = usePolling(() => api.liveSieges(), 5000);
  const now = useNow(30_000);

  const liveMap = useMemo(() => {
    const m = new Map<string, LiveSiege>();
    for (const s of live.data?.sieges ?? []) {
      // an op of five messages left open this long was abandoned (a visitor walked away): not LIVE
      if (now && Date.parse(s.createdAt) < now - ABANDONED_MS) continue;
      if (!m.has(s.castleId) || m.get(s.castleId)!.turn < s.turn) m.set(s.castleId, s);
    }
    return m;
  }, [live.data, now]);
  const liveIds = useMemo(() => new Set(liveMap.keys()), [liveMap]);

  const castles = useMemo(() => data?.castles ?? [], [data]);
  const shown = useMemo(() => sortCastles(q.all ? castles : castles.filter((c) => vaultStateOf(c) === "guarding"), order, liveIds), [castles, q.all, order, liveIds]);
  const all = useMemo(() => every.data?.castles ?? castles, [every.data, castles]);
  const resting = useMemo(() => all.filter((c) => vaultStateOf(c) !== "guarding"), [all]);
  const guardingAll = useMemo(() => all.filter((c) => vaultStateOf(c) === "guarding"), [all]);
  const names = useMemo(() => new Map(all.map((c) => [c.id, c.name])), [all]);

  const activeFilters = [q.tier, q.minPot, q.all].filter(Boolean).length;

  const reconOpen = params.get("recon") === "1";
  const closeRecon = useCallback(() => {
    playCue("ui_blip");
    router.replace(gridUrl(pathname, new URLSearchParams(params), q, params.get("order"), ["recon"]), { scroll: false });
  }, [router, pathname, params, q]);
  const leaveRecon = useCallback(() => {
    // Drop ?recon=1 from this history entry so Back from the Op room doesn't reopen the card.
    window.history.replaceState(null, "", gridUrl(pathname, new URLSearchParams(params), q, params.get("order"), ["recon"]));
  }, [pathname, params, q]);
  const openRecon = useCallback(() => {
    const p = new URLSearchParams(params);
    p.set("recon", "1");
    router.replace(`${pathname}?${p}`, { scroll: false });
  }, [router, pathname, params]);

  return (
    <div className="flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 pt-6 pb-10 sm:px-6 sm:pt-8">
        <header className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-xl">
            <h1 className="text-2xl tracking-tight text-ink glow sm:text-3xl">THE GRID</h1>
            <p className="mt-2 text-[15px] leading-relaxed text-ink-dim">
              AI guards hold vaults of test HBAR. Pay an op fee via x402 and get five messages to talk one into unlocking. Every op the guard holds grows the pot.
            </p>
            <button
              type="button"
              onClick={openRecon}
              className="mt-3 font-ui text-[11px] tracking-[0.1em] text-accent uppercase underline decoration-accent/40 underline-offset-4 hover:decoration-accent"
            >
              First time? Run a free recon ▶
            </button>
          </div>
          <SeasonStrip castles={all} loading={!every.data && !data} className="lg:min-w-[600px]" />
        </header>

        <Grid
          castles={shown}
          live={liveMap}
          now={now}
          loading={loading && !data}
          error={error}
          onRetry={() => void refresh()}
          filtered={Boolean(key)}
          toolbar={
            <>
              <SortChips value={order} onChange={setOrder} />
              <BoardFilters value={q} onChange={setQ} omit={["sort"]} className="max-sm:hidden" />
              <details className="group sm:hidden">
                <summary className="flex min-h-8 cursor-pointer list-none items-center gap-2 font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase [&::-webkit-details-marker]:hidden">
                  <span className="group-open:rotate-90" aria-hidden>
                    ▶
                  </span>
                  Filters{activeFilters ? <span className="text-accent">· {activeFilters} on</span> : null}
                </summary>
                <BoardFilters value={q} onChange={setQ} omit={["sort"]} className="mt-2 flex-col" />
              </details>
            </>
          }
          meta={<ArkivBar meta={data?.arkiv} />}
        />

        {!q.all ? <NotTakingOps castles={resting} now={now} noneGuarding={every.data ? guardingAll.length === 0 : false} /> : null}
      </div>

      <GridTicker names={names} />
      <ReconBriefing open={reconOpen} castles={guardingAll} loading={!every.data} onClose={closeRecon} onLeave={leaveRecon} />
    </div>
  );
}
