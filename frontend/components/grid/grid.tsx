"use client";

import type * as React from "react";
import type { CastleRow, LiveSiege } from "@/lib/api/client";
import { EMPTY } from "@/lib/vocab";
import { ErrorState, EmptyState, Skeleton } from "@/components/ui/state";
import { cn } from "@/lib/utils";
import { VaultCard } from "./vault-card";

export type GridProps = {
  castles: CastleRow[];
  /** Live ops by vault id (api.liveSieges). */
  live?: ReadonlyMap<string, LiveSiege>;
  now?: number;
  /** Slot: sort chips + the Arkiv filters. */
  toolbar?: React.ReactNode;
  /** Slot: the "read from Arkiv · block N" line. */
  meta?: React.ReactNode;
  /** Slot: extra chips per card. */
  cardBadges?: (c: CastleRow) => React.ReactNode;
  /** Slot: extra content per card. */
  cardExtras?: (c: CastleRow) => React.ReactNode;
  /** Slot: per-card footer (defaults to the Arkiv owner + expiry). */
  cardFooter?: (c: CastleRow) => React.ReactNode;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Filters are active: an empty result is "no match", not "no vaults". */
  filtered?: boolean;
  className?: string;
};

/**
 * The Grid: toolbar slot → meta slot → vault cards (3-up desktop, 2-up tablet, 1-up phone).
 * Loading = six scanline tiles; error = API OFFLINE + retry; empty = GRID OFFLINE.
 *
 * @example <Grid castles={rows} live={liveMap} toolbar={<SortChips/>} meta={<ArkivBar meta={m} />} />
 */
export function Grid({ castles, live, now = 0, toolbar, meta, cardBadges, cardExtras, cardFooter, loading, error, onRetry, filtered, className }: GridProps) {
  return (
    <section aria-label="Vaults" className={cn("flex min-w-0 flex-col gap-4", className)}>
      {toolbar ? <div className="flex min-w-0 flex-col gap-3">{toolbar}</div> : null}
      {meta}
      {error && castles.length === 0 ? (
        <ErrorState error={error} onRetry={onRetry} title="API OFFLINE" />
      ) : loading && castles.length === 0 ? (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3" aria-busy>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[236px] px-frame" />
          ))}
        </div>
      ) : castles.length === 0 ? (
        filtered ? (
          <EmptyState title="NO VAULT MATCHES" hint="The query ran and came back empty. Loosen a filter." />
        ) : (
          <EmptyState
            title={EMPTY.grid.title}
            hint={
              <>
                No vaults seeded. Run <code className="font-mono text-ink">npm run seed</code>.
              </>
            }
          />
        )
      ) : (
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          {castles.map((c) => (
            <VaultCard
              key={c.id}
              castle={c}
              arkiv={c.arkiv}
              live={live?.get(c.id)}
              now={now}
              badges={cardBadges?.(c)}
              extras={cardExtras?.(c)}
              footer={cardFooter ? cardFooter(c) : undefined}
            />
          ))}
        </div>
      )}
    </section>
  );
}
