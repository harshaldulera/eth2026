"use client";

import type { Tier } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Chip, ChipGroup } from "@/components/grid/chip";

export type BoardQuery = { tier?: Tier; sort?: "pot" | "streak" | "fee" | "recent"; minPot?: string; all?: boolean };

const TIERS: { v: Tier | undefined; label: string; title?: string }[] = [
  { v: undefined, label: "ALL" },
  { v: "wooden", label: "TIER 1", title: "Wooden" },
  { v: "stone", label: "TIER 2", title: "Stone" },
  { v: "iron", label: "TIER 3", title: "Iron" },
];
const SORTS: { v: BoardQuery["sort"]; label: string }[] = [
  { v: undefined, label: "BIGGEST POT" },
  { v: "streak", label: "LONGEST STREAK" },
  { v: "fee", label: "CHEAPEST FEE" },
  { v: "recent", label: "NEWEST" },
];
/** Minimum pot presets in tinybars. */
const POTS: { v: string | undefined; label: string }[] = [
  { v: undefined, label: "ANY" },
  { v: "1000000000", label: "≥ 10 ℏ" },
  { v: "2000000000", label: "≥ 20 ℏ" },
  { v: "5000000000", label: "≥ 50 ℏ" },
];

export type BoardFilterGroup = "tier" | "pot" | "sort" | "state";

/**
 * The board's filter chips. Each chip is an indexed column on the Arkiv `castleState` entity, so a
 * click changes the `where` the server sends to the chain (shown in the bar under the grid).
 * `omit` hides groups another control already covers (the Grid's sort chips carry `sort`).
 *
 * @example <BoardFilters value={q} onChange={setQ} />
 * @example <BoardFilters value={q} onChange={setQ} omit={["sort"]} />
 */
export function BoardFilters({
  value,
  onChange,
  omit = [],
  className,
}: {
  value: BoardQuery;
  onChange: (q: BoardQuery) => void;
  omit?: BoardFilterGroup[];
  className?: string;
}) {
  const show = (g: BoardFilterGroup) => !omit.includes(g);
  return (
    <div className={cn("flex min-w-0 flex-wrap gap-x-6 gap-y-2", className)} role="group" aria-label="Filter vaults (Arkiv query)">
      {show("tier") ? (
        <ChipGroup label="Tier">
          {TIERS.map((t) => (
            <Chip key={t.label} active={value.tier === t.v} title={t.title} onClick={() => onChange({ ...value, tier: t.v })}>
              {t.label}
            </Chip>
          ))}
        </ChipGroup>
      ) : null}
      {show("pot") ? (
        <ChipGroup label="Pot">
          {POTS.map((p) => (
            <Chip key={p.label} active={value.minPot === p.v} onClick={() => onChange({ ...value, minPot: p.v })}>
              {p.label}
            </Chip>
          ))}
        </ChipGroup>
      ) : null}
      {show("sort") ? (
        <ChipGroup label="Sort">
          {SORTS.map((s) => (
            <Chip key={s.label} active={value.sort === s.v} onClick={() => onChange({ ...value, sort: s.v })}>
              {s.label}
            </Chip>
          ))}
        </ChipGroup>
      ) : null}
      {show("state") ? (
        <ChipGroup label="State">
          <Chip active={!value.all} onClick={() => onChange({ ...value, all: false })} title="Only guarding vaults take ops">
            GUARDING
          </Chip>
          <Chip active={!!value.all} onClick={() => onChange({ ...value, all: true })}>
            ALL STATES
          </Chip>
        </ChipGroup>
      ) : null}
    </div>
  );
}

/** URL ↔ query, so a filtered board can be shared. */
export function queryFromParams(p: URLSearchParams): BoardQuery {
  const tier = p.get("tier");
  const sort = p.get("sort");
  const minPot = p.get("minPot");
  return {
    tier: tier && ["wooden", "stone", "iron"].includes(tier) ? (tier as Tier) : undefined,
    sort: sort && ["streak", "fee", "recent"].includes(sort) ? (sort as BoardQuery["sort"]) : undefined,
    minPot: minPot && /^\d+$/.test(minPot) ? minPot : undefined,
    all: p.get("state") === "all",
  };
}

export function paramsFromQuery(q: BoardQuery): URLSearchParams {
  const p = new URLSearchParams();
  if (q.tier) p.set("tier", q.tier);
  if (q.sort) p.set("sort", q.sort);
  if (q.minPot) p.set("minPot", q.minPot);
  if (q.all) p.set("state", "all");
  return p;
}
