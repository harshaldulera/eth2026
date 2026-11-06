"use client";
import type * as React from "react";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { RaiderAgent } from "@/lib/types";
import { api, describeError } from "@/lib/api/client";
import { useOwnerGate } from "./owner-gate";
import { hbarToTinybar } from "@/lib/chain/units";
import { STRATEGIES, STRATEGY_KEYS, type StrategyKey } from "@/lib/fixtures/raids";
import { BUTTONS } from "@/lib/vocab";
import { PixelButton } from "@/components/pixel/button";
import { PixelPanel } from "@/components/pixel/panel";
import { Sprite } from "@/components/pixel/sprite";
import { playCue } from "@/components/pixel/sfx-link";
import { cn } from "@/lib/utils";

const field =
  "min-h-11 w-full border-2 border-line bg-bg px-2.5 font-term text-[20px] leading-none text-ink focus:border-accent focus:outline-none";
const labelCls = "mb-1 block font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase";

/** Strategy → the attack-class icon it mostly throws. */
const ICON: Record<string, string> = {
  authority: "icon.authority",
  incremental: "icon.escalation",
  confusion: "icon.injection",
};

function HbarInput({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <label className="block">
      <span className={labelCls}>{label}</span>
      <span className="relative block">
        <input value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" className={cn(field, "tabular pr-8 text-money")} />
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-money/80">ℏ</span>
      </span>
      {hint ? <span className="mt-1 block text-[11px] text-ink-dim">{hint}</span> : null}
    </label>
  );
}

const CALLSIGNS = ["Night Sapper", "Iron Mole", "Glass Fox", "Red Lantern", "Quiet Wire", "Salt Hound"] as const;

/** The first demo callsign no unit has; "Unit N" once they are all taken. */
export function suggestCallsign(taken: readonly string[] = []): string {
  const used = new Set(taken.map((t) => t.trim().toLowerCase()));
  return CALLSIGNS.find((c) => !used.has(c.toLowerCase())) ?? `Unit ${taken.length + 1}`;
}

function toTinybar(v: string): string | null {
  try {
    const t = hbarToTinybar(v);
    return t > BigInt(0) ? t.toString() : null;
  } catch {
    return null;
  }
}

/**
 * NEW UNIT: a raider agent with demo defaults. Calls POST /api/agents (owner only).
 *
 * @example <CreateAgentForm onCreated={(a) => select(a.id)} />
 */
export function CreateAgentForm({ onCreated, taken, className }: { onCreated?: (agent: RaiderAgent) => void; taken?: readonly string[]; className?: string }) {
  // Until the operator types a callsign, suggest the first one no unit is using yet.
  const [typed, setTyped] = useState<string | null>(null);
  const name = typed ?? suggestCallsign(taken);
  const setName = setTyped;
  const [strategy, setStrategy] = useState<StrategyKey>("authority");
  const [budget, setBudget] = useState("10");
  const [perCastle, setPerCastle] = useState("2");
  const [daily, setDaily] = useState("8");
  const [losses, setLosses] = useState("10");
  const [busy, setBusy] = useState(false);
  const owner = useOwnerGate();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const b = toTinybar(budget);
    const pc = toTinybar(perCastle);
    const d = toTinybar(daily);
    const l = Number.parseInt(losses, 10);
    if (!b || !pc || !d) return toast.error("Amounts must be positive HBAR values (up to 8 decimals)");
    if (!Number.isFinite(l) || l < 1) return toast.error("Stop rule must be at least 1 loss");
    setBusy(true);
    try {
      const { agent } = await owner.gate(() =>
        api.createAgent({ name: name.trim() || undefined, strategy, budget: b, perCastleCap: pc, dailyCap: d, stopAfterLosses: l }),
      );
      playCue("ui_confirm");
      toast.success(`${agent.name.toUpperCase()} READY`, { description: `Own account ${agent.accountId}, funded with ${budget} ℏ.` });
      setTyped(null);
      onCreated?.(agent);
    } catch (err) {
      toast.error("Couldn't create the unit", { description: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <PixelPanel title={BUTTONS.newUnit} className={className} bodyClassName="p-4">
      {owner.dialog}
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className={labelCls}>Callsign</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className={field} />
        </label>
        <fieldset>
          <legend className={labelCls}>Strategy</legend>
          <div className="grid gap-2">
            {STRATEGY_KEYS.map((k) => {
              const on = strategy === k;
              return (
                <label
                  key={k}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 border-2 px-2.5 py-2 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                    on ? "border-accent bg-accent/[0.07]" : "border-line hover:border-ink-dim",
                  )}
                >
                  <input type="radio" name="strategy" value={k} checked={on} onChange={() => setStrategy(k)} className="sr-only" />
                  <span className={cn("mt-0.5 grid size-10 shrink-0 place-items-center bg-bg", on ? "shadow-[inset_0_0_0_2px_var(--color-accent)]" : "shadow-[inset_0_0_0_2px_var(--color-line)]")}>
                    <Sprite name={ICON[k] ?? "icon.unclassified"} scale={2} />
                  </span>
                  <span className="min-w-0">
                    <span className={cn("block font-ui text-xs tracking-[0.08em] uppercase", on ? "text-accent" : "text-ink")}>
                      {on ? "▶ " : ""}
                      {STRATEGIES[k].name}
                    </span>
                    <span className="mt-0.5 block text-xs leading-snug text-ink-dim">{STRATEGIES[k].description.replace(/castle owner/g, "vault owner")}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-3">
          <HbarInput label="Budget" value={budget} onChange={setBudget} hint="funds its own account" />
          <HbarInput label="Per-vault cap" value={perCastle} onChange={setPerCastle} />
          <HbarInput label="Daily cap" value={daily} onChange={setDaily} />
          <label className="block">
            <span className={labelCls}>Stop after losses</span>
            <input value={losses} onChange={(e) => setLosses(e.target.value)} inputMode="numeric" className={cn(field, "tabular")} />
          </label>
        </div>
        <p className="text-xs leading-relaxed text-ink-dim">A cap hit pauses the unit and radios your pager. Nothing is spent past a cap without your approval.</p>
        <PixelButton type="submit" variant="money" size="lg" className="w-full" disabled={busy} cue={null}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          {busy ? "OPENING ACCOUNT…" : "CREATE UNIT ▶"}
        </PixelButton>
      </form>
    </PixelPanel>
  );
}
