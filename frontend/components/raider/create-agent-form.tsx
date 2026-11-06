"use client";
import type * as React from "react";

import { useState } from "react";
import { toast } from "sonner";
import { Bot, Loader2 } from "lucide-react";
import type { RaiderAgent } from "@/lib/types";
import { api, asOwner, describeError } from "@/lib/api/client";
import { hbarToTinybar } from "@/lib/chain/units";
import { STRATEGIES, STRATEGY_KEYS, type StrategyKey } from "@/lib/fixtures/raids";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const field = "h-10 w-full rounded-lg border border-arena-line bg-arena-bg/60 px-3 text-sm text-parchment focus:border-gold/50 focus:outline-none";

function HbarInput({ label, value, onChange, hint }: { label: string; value: string; onChange: (v: string) => void; hint?: string }) {
  return (
    <label className="block text-xs text-stone">
      {label}
      <span className="relative mt-1 block">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          className={cn(field, "tabular pr-8 text-gold")}
        />
        <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-gold/70">ℏ</span>
      </span>
      {hint ? <span className="mt-1 block text-[11px] text-stone/80">{hint}</span> : null}
    </label>
  );
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
 * New raider agent with sensible demo defaults. Calls POST /api/agents.
 *
 * @example <CreateAgentForm onCreated={(a) => select(a.id)} />
 */
export function CreateAgentForm({ onCreated, className }: { onCreated?: (agent: RaiderAgent) => void; className?: string }) {
  const [name, setName] = useState("Night Sapper");
  const [strategy, setStrategy] = useState<StrategyKey>("authority");
  const [budget, setBudget] = useState("10");
  const [perCastle, setPerCastle] = useState("2");
  const [daily, setDaily] = useState("8");
  const [losses, setLosses] = useState("10");
  const [busy, setBusy] = useState(false);

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
      const { agent } = await asOwner(() =>
        api.createAgent({ name: name.trim() || undefined, strategy, budget: b, perCastleCap: pc, dailyCap: d, stopAfterLosses: l }),
      );
      toast.success(`${agent.name} is ready`, { description: `Own account ${agent.accountId}, funded with ${budget} ℏ.` });
      onCreated?.(agent);
    } catch (err) {
      toast.error("Couldn't create the agent", { description: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className={className}>
      <CardHeader title="New raider agent" icon={<Bot />} />
      <CardBody>
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-xs text-stone">
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className={cn(field, "mt-1")} />
          </label>
          <fieldset>
            <legend className="text-xs text-stone">Strategy</legend>
            <div className="mt-1 grid gap-1.5">
              {STRATEGY_KEYS.map((k) => (
                <label
                  key={k}
                  className={cn(
                    "flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2 transition-colors",
                    strategy === k ? "border-ember/50 bg-ember/[0.06]" : "border-arena-line hover:border-stone/40",
                  )}
                >
                  <input type="radio" name="strategy" value={k} checked={strategy === k} onChange={() => setStrategy(k)} className="mt-1 accent-[var(--color-ember)]" />
                  <span>
                    <span className="block text-sm text-parchment">{STRATEGIES[k].name}</span>
                    <span className="block text-xs text-stone">{STRATEGIES[k].description}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <HbarInput label="Budget" value={budget} onChange={setBudget} hint="funds its own account" />
            <HbarInput label="Per-castle cap" value={perCastle} onChange={setPerCastle} />
            <HbarInput label="Daily cap" value={daily} onChange={setDaily} />
            <label className="block text-xs text-stone">
              Stop after losses
              <input value={losses} onChange={(e) => setLosses(e.target.value)} inputMode="numeric" className={cn(field, "tabular mt-1")} />
            </label>
          </div>
          <p className="text-[11px] leading-relaxed text-stone">Hitting any cap pauses the agent and asks you on your phone. Nothing is spent past a cap without your approval.</p>
          <Button type="submit" variant="emberSolid" size="lg" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Bot />}
            {busy ? "Creating account…" : "Create agent"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
