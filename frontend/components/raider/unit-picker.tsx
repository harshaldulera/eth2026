"use client";

import { useState } from "react";
import { api, type MyUnit } from "@/lib/api/client";
import { useHasOperatorKeys } from "@/lib/agents/use-operator-keys";
import { usePolling } from "@/lib/hooks/usePolling";
import { UNITS } from "@/lib/vocab";
import { cn } from "@/lib/utils";

/**
 * The red teamer's units and operator accounts held in this browser (operator keys in localStorage),
 * not stopped, each with its account `balance`; none without keys. `refresh` re-reads them at once
 * (right after a new account's key was saved).
 */
export function useMyUnits(): { units: MyUnit[]; unit: MyUnit | null; selected: string; setSelected: (id: string) => void; refresh: () => Promise<void> } {
  const keyed = useHasOperatorKeys();
  const mine = usePolling(() => api.agents({ mine: true }), 10_000, { key: "my-units", enabled: keyed });
  const units = (mine.data?.agents ?? []).filter((a) => a.status !== "stopped");
  // "" = the demo wallet (stub hatch only). Until the red teamer picks, the first unit pays.
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? units[0]?.id ?? "";
  const unit = units.find((a) => a.id === selected) ?? null;
  return { units, unit, selected: unit ? selected : "", setSelected: setPicked, refresh: mine.refresh };
}

/**
 * The callsign of `agentId` when it is one of this browser's own units or operator accounts (its
 * operator key is here), else undefined: "paid from GLASS FOX", "paid to GLASS FOX · YOUR ACCOUNT".
 */
export function useMyUnitName(agentId: string | null | undefined): string | undefined {
  const keyed = useHasOperatorKeys();
  const mine = usePolling(() => api.agents({ mine: true }), 10_000, { key: "my-units", enabled: keyed && Boolean(agentId) });
  return agentId ? mine.data?.agents.find((a) => a.id === agentId)?.name : undefined;
}

/** The picker's `+ NEW ACCOUNT` option: never a unit id (ids are `agent_…`). */
const NEW_ACCOUNT = "+new";

/**
 * `PAY FROM <UNIT>` picker on the vault page: only renders when this browser holds a unit's operator key.
 * The DEMO WALLET option exists only while the server allows demo-wallet ops (`allowDemo`, stub hatch).
 * `onNewAccount` adds `+ NEW ACCOUNT`, which opens FUND YOUR OPERATOR ACCOUNT instead of selecting.
 */
export function UnitPicker({
  units,
  selected,
  onSelect,
  onNewAccount,
  disabled,
  allowDemo,
  className,
}: {
  units: MyUnit[];
  selected: string;
  onSelect: (id: string) => void;
  onNewAccount?: () => void;
  disabled?: boolean;
  allowDemo?: boolean;
  className?: string;
}) {
  if (units.length === 0) return null;
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">{UNITS.payFromLabel}</span>
      <select
        value={selected}
        onChange={(e) => (e.target.value === NEW_ACCOUNT ? onNewAccount?.() : onSelect(e.target.value))}
        disabled={disabled}
        data-testid="unit-picker"
        className="min-h-11 w-full border-2 border-line bg-bg px-2.5 font-term text-[20px] leading-none text-ink focus:border-accent focus:outline-none disabled:opacity-60"
      >
        {units.map((u) => (
          <option key={u.id} value={u.id}>
            {u.name.toUpperCase()}
          </option>
        ))}
        {allowDemo ? <option value="">{UNITS.demoWallet}</option> : null}
        {onNewAccount ? <option value={NEW_ACCOUNT}>{UNITS.newAccountOption}</option> : null}
      </select>
    </label>
  );
}
