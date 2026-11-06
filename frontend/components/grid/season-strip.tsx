"use client";

import { useMemo } from "react";
import type { Castle } from "@/lib/types";
import { api, type StatsResponse } from "@/lib/api/client";
import { usePolling } from "@/lib/hooks/usePolling";
import { vaultStateOf } from "@/lib/money/vault";
import { formatAmount, toUnits } from "@/lib/money/format";
import { Digits } from "@/components/pixel/digits";
import { cn } from "@/lib/utils";

/** Plan §2.9 `GET /api/stats` season block; any field may be missing in the fallback. */
export type SeasonCounts = Partial<StatsResponse["season"]>;

/** Season counters computed from the vault list (fallback while api.stats is missing). */
export function seasonFromCastles(castles: readonly Castle[]): SeasonCounts {
  const guarding = castles.filter((c) => vaultStateOf(c) === "guarding");
  return {
    vaults: castles.length,
    guarding: guarding.length,
    ops: castles.reduce((n, c) => n + (c.siegeCount ?? 0), 0),
    breaches: castles.filter((c) => vaultStateOf(c) === "broken").length,
    inPots: guarding.reduce((sum, c) => sum + toUnits(c.pot), BigInt(0)).toString(),
  };
}

/**
 * GUARDING · IN VAULTS · OPS · BREACHES as arcade counters from `api.stats().season`; until that
 * answers (or if it fails) they are counted from `castles` (every vault, not the filtered Grid).
 *
 * @example <SeasonStrip castles={allCastles} loading={!all} />
 */
export function SeasonStrip({ castles, loading, className }: { castles: readonly Castle[]; loading?: boolean; className?: string }) {
  const stats = usePolling(() => api.stats(), 10_000);
  const fallback = useMemo(() => seasonFromCastles(castles), [castles]);
  const s: SeasonCounts = { ...fallback, ...(stats.data?.season ?? {}) };
  const asset = castles[0]?.asset;
  const pots = formatAmount(s.inPots ?? "0", asset, { symbol: false, maxDecimals: 0 });
  const items: { k: string; v: React.ReactNode; tone?: "money" | "ink" }[] = [
    { k: "GUARDING", v: <Digits value={s.guarding ?? 0} pad={2} size="lg" /> },
    { k: "IN VAULTS", v: <Digits value={pots} unit="ℏ" size="lg" tone="money" /> },
    { k: "OPS", v: <Digits value={s.ops ?? 0} pad={4} size="lg" /> },
    { k: "BREACHES", v: <Digits value={s.breaches ?? 0} pad={2} size="lg" tone="money" /> },
  ];
  return (
    <dl
      aria-busy={loading}
      aria-label="Season"
      className={cn(
        "grid min-w-0 grid-cols-4 bg-bg px-frame",
        loading && "opacity-60",
        className,
      )}
    >
      {items.map((it, i) => (
        <div key={it.k} className={cn("flex min-w-0 flex-col gap-2 px-2 py-2.5 sm:px-4 sm:py-3", i > 0 && "border-l-2 border-line")}>
          <dt className="truncate font-ui text-[9px] tracking-[0.12em] whitespace-nowrap text-ink-dim sm:text-[10px] sm:tracking-[0.16em]">{it.k}</dt>
          <dd className="whitespace-nowrap max-sm:[&>span]:text-[14px]">{it.v}</dd>
        </div>
      ))}
    </dl>
  );
}
