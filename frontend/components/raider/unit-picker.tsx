"use client";

import { useState } from "react";
import type { RaiderAgent } from "@/lib/types";
import { api } from "@/lib/api/client";
import { useHasOperatorKeys } from "@/lib/agents/use-operator-keys";
import { usePolling } from "@/lib/hooks/usePolling";
import { UNITS } from "@/lib/vocab";
import { cn } from "@/lib/utils";

/** The red teamer's units held in this browser (operator keys in localStorage), not stopped; none without keys. */
export function useMyUnits(): { units: RaiderAgent[]; unit: RaiderAgent | null; selected: string; setSelected: (id: string) => void } {
  const keyed = useHasOperatorKeys();
  const mine = usePolling(() => api.agents({ mine: true }), 10_000, { key: "my-units", enabled: keyed });
  const units = (mine.data?.agents ?? []).filter((a) => a.status !== "stopped");
  // "" = the demo wallet. Until the red teamer picks, the first unit pays.
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? units[0]?.id ?? "";
  const unit = units.find((a) => a.id === selected) ?? null;
  return { units, unit, selected: unit ? selected : "", setSelected: setPicked };
}

/**
 * `PAY FROM <UNIT>` picker on the vault page: only renders when this browser holds a unit's operator key.
 * Choosing the demo wallet keeps today's path.
 */
export function UnitPicker({ units, selected, onSelect, disabled, className }: { units: RaiderAgent[]; selected: string; onSelect: (id: string) => void; disabled?: boolean; className?: string }) {
  if (units.length === 0) return null;
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">{UNITS.payFromLabel}</span>
      <select
        value={selected}
        onChange={(e) => onSelect(e.target.value)}
        disabled={disabled}
        data-testid="unit-picker"
        className="min-h-11 w-full border-2 border-line bg-bg px-2.5 font-term text-[20px] leading-none text-ink focus:border-accent focus:outline-none disabled:opacity-60"
      >
        {units.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name.toUpperCase()}
          </option>
        ))}
        <option value="">{UNITS.demoWallet}</option>
      </select>
    </label>
  );
}
