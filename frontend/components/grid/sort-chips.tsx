"use client";

import { ORDERS, type GridOrder } from "./sort";
import { ChipGroup, Chip } from "./chip";

/**
 * EASIEST · BIGGEST POT · QUIET · LONGEST STREAK (+ the Arkiv sorts CHEAPEST FEE · NEWEST).
 *
 * @example <SortChips value={order} onChange={setOrder} />
 */
export function SortChips({ value, onChange, className }: { value: GridOrder; onChange: (o: GridOrder) => void; className?: string }) {
  return (
    <ChipGroup label="Sort" className={className}>
      {ORDERS.map((o) => (
        <Chip key={o.v} active={value === o.v} title={o.title} onClick={() => onChange(o.v)}>
          {o.label}
        </Chip>
      ))}
    </ChipGroup>
  );
}
