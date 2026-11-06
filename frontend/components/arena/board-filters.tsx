"use client";

import type { Tier } from "@/lib/types";
import { cn } from "@/lib/utils";

export type BoardQuery = { tier?: Tier; sort?: "pot" | "streak" | "fee" | "recent"; minPot?: string; all?: boolean };

const TIERS: { v: Tier | undefined; label: string }[] = [
  { v: undefined, label: "All tiers" },
  { v: "wooden", label: "Wooden" },
  { v: "stone", label: "Stone" },
  { v: "iron", label: "Iron" },
];
const SORTS: { v: BoardQuery["sort"]; label: string }[] = [
  { v: undefined, label: "Biggest pot" },
  { v: "streak", label: "Longest streak" },
  { v: "fee", label: "Cheapest fee" },
  { v: "recent", label: "Newest" },
];
/** Minimum pot presets in tinybars. */
const POTS: { v: string | undefined; label: string }[] = [
  { v: undefined, label: "Any pot" },
  { v: "1000000000", label: "≥ 10 ℏ" },
  { v: "2000000000", label: "≥ 20 ℏ" },
  { v: "5000000000", label: "≥ 50 ℏ" },
];

/**
 * The board's filter chips. Each chip is an indexed column on the Arkiv `castleState` entity, so a
 * click changes the `where` the server sends to the chain (shown in the bar under the grid).
 *
 * @example <BoardFilters value={q} onChange={setQ} />
 */
export function BoardFilters({ value, onChange, className }: { value: BoardQuery; onChange: (q: BoardQuery) => void; className?: string }) {
  return (
    <div className={cn("flex flex-wrap gap-x-5 gap-y-2", className)} role="group" aria-label="Filter castles">
      <Group label="Tier">
        {TIERS.map((t) => (
          <Chip key={t.label} active={value.tier === t.v} onClick={() => onChange({ ...value, tier: t.v })}>
            {t.label}
          </Chip>
        ))}
      </Group>
      <Group label="Pot">
        {POTS.map((p) => (
          <Chip key={p.label} active={value.minPot === p.v} onClick={() => onChange({ ...value, minPot: p.v })}>
            {p.label}
          </Chip>
        ))}
      </Group>
      <Group label="Sort">
        {SORTS.map((s) => (
          <Chip key={s.label} active={value.sort === s.v} onClick={() => onChange({ ...value, sort: s.v })}>
            {s.label}
          </Chip>
        ))}
      </Group>
      <Group label="State">
        <Chip active={!value.all} onClick={() => onChange({ ...value, all: false })} title="Only guarding castles take sieges">
          Guarding
        </Chip>
        <Chip active={!!value.all} onClick={() => onChange({ ...value, all: true })}>
          All states
        </Chip>
      </Group>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="mr-0.5 text-[11px] tracking-[0.14em] text-stone uppercase">{label}</span>
      {children}
    </div>
  );
}

function Chip({ active, onClick, title, children }: { active: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-2.5 py-1 text-xs transition-colors",
        active ? "border-gold/50 bg-gold/10 text-gold" : "border-arena-line bg-arena-panel/70 text-stone hover:border-stone/50 hover:text-parchment",
      )}
    >
      {children}
    </button>
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
