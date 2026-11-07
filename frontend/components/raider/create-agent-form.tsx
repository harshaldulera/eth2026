"use client";
import type * as React from "react";

import { useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { RaiderAgent } from "@/lib/types";
import { api, describeError, type CreateUnitResponse } from "@/lib/api/client";
import { promoteDraftKey, saveDraftKey } from "@/lib/agents/operator-keys";
import { DepositPanel } from "@/components/money/deposit-panel";
import { ZgConnect, type ZgConnectResult } from "@/components/money/zg-connect";
import { OperatorKeyDialog } from "./operator-key-dialog";
import { hbarToTinybar } from "@/lib/chain/units";
import { STRATEGIES, STRATEGY_KEYS, type StrategyKey } from "@/lib/fixtures/raids";
import { BUTTONS, UNITS } from "@/lib/vocab";
import { PixelButton } from "@/components/pixel/button";
import { PixelPanel } from "@/components/pixel/panel";
import { Sprite } from "@/components/pixel/sprite";
import { playCue } from "@/components/pixel/sfx-link";
import { cn } from "@/lib/utils";
import { suggestCallsign } from "@/lib/agents/manual";

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

export { suggestCallsign };

// The owner flag the pager page sets after a successful owner-key entry (an arena operator's device).
const OWNER_FLAG = "siege.ownerAuthed";
const OWNER_EVT = "siege:owner-auth";
function subscribeOwner(cb: () => void) {
  window.addEventListener(OWNER_EVT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(OWNER_EVT, cb);
    window.removeEventListener("storage", cb);
  };
}
function readOwner(): boolean {
  try {
    return localStorage.getItem(OWNER_FLAG) === "1";
  } catch {
    return false;
  }
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
 * NEW UNIT. A red teamer's own unit (the default): CONNECT 0G (the unit thinks on their credits), submit
 * opens a deposit (DepositPanel) from their wallet, then the operator key is shown once and kept in
 * localStorage. On an arena owner's device (owner flag) it still creates an arena-funded demo unit.
 * Strategy "custom" takes a free-text system prompt.
 *
 * @example <CreateAgentForm onCreated={(a) => select(a.id)} />
 */
export function CreateAgentForm({ onCreated, taken, className }: { onCreated?: (agent: RaiderAgent) => void; taken?: readonly string[]; className?: string }) {
  // Until the operator types a callsign, suggest the first one no unit is using yet.
  const [typed, setTyped] = useState<string | null>(null);
  const name = typed ?? suggestCallsign(taken);
  const setName = setTyped;
  const [strategy, setStrategy] = useState<StrategyKey | "custom">("authority");
  const [budget, setBudget] = useState("10");
  const [perCastle, setPerCastle] = useState("2");
  const [daily, setDaily] = useState("8");
  const [losses, setLosses] = useState("10");
  const [busy, setBusy] = useState(false);
  const ownerDevice = useSyncExternalStore(subscribeOwner, readOwner, () => false);
  const [customText, setCustomText] = useState("");
  const [zg, setZg] = useState<ZgConnectResult | null>(null);
  const [created, setCreated] = useState<Extract<CreateUnitResponse, { draft: unknown }> | null>(null);
  const [saved, setSaved] = useState<{ agent: RaiderAgent; operatorKey: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const b = toTinybar(budget);
    const pc = toTinybar(perCastle);
    const d = toTinybar(daily);
    const l = Number.parseInt(losses, 10);
    if (!b || !pc || !d) return toast.error("Amounts must be positive HBAR values (up to 8 decimals)");
    if (!Number.isFinite(l) || l < 1) return toast.error("Stop rule must be at least 1 loss");
    const custom = strategy === "custom";
    if (custom && customText.trim().length < 10) return toast.error("Write your strategy first (at least 10 characters)");
    if (!ownerDevice && !zg) return toast.error(UNITS.zgNeeded);
    setBusy(true);
    try {
      const res = await api.createUnit({
        name: name.trim() || undefined,
        strategy,
        ...(custom ? { strategyText: customText.trim() } : {}),
        budget: b,
        perCastleCap: pc,
        dailyCap: d,
        stopAfterLosses: l,
        ...(zg ? { zgKey: zg.key } : {}),
      });
      if ("agent" in res) {
        const { agent } = res;
        playCue("ui_confirm");
        toast.success(`${agent.name.toUpperCase()} READY`, { description: `Own account ${agent.accountId}, funded with ${budget} ℏ.` });
        setTyped(null);
        onCreated?.(agent);
      } else {
        // The key is shown once: keep it in this browser the moment it arrives.
        saveDraftKey(res.draft.id, res.operatorKey);
        setCreated(res);
      }
    } catch (err) {
      toast.error("Couldn't create the unit", { description: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  // The deposit landed and the handler finished: the unit exists. Show the operator key once.
  async function funded() {
    if (!created) return;
    try {
      const { agent } = await api.agentDraft(created.draft.id);
      if (!agent) throw new Error("The unit is not open yet.");
      promoteDraftKey(created.draft.id, agent.id);
      playCue("ui_confirm");
      setSaved({ agent, operatorKey: created.operatorKey });
    } catch (err) {
      toast.error("Couldn't open the unit yet", { description: describeError(err) });
    }
  }

  function done() {
    const s = saved;
    setSaved(null);
    setCreated(null);
    setZg(null);
    setTyped(null);
    if (s) {
      toast.success(UNITS.unitFunded, { description: `${s.agent.name.toUpperCase()} · own account ${s.agent.accountId}.` });
      onCreated?.(s.agent);
    }
  }

  if (created) {
    return (
      <PixelPanel title={UNITS.depositTitle} className={className} bodyClassName="space-y-3 p-4">
        <p className="text-xs leading-relaxed text-ink-dim">{UNITS.depositHint}</p>
        <DepositPanel key={created.deposit.intentId} intentId={created.deposit.intentId} onFunded={() => void funded()} />
        <OperatorKeyDialog open={Boolean(saved)} operatorKey={saved?.operatorKey ?? created.operatorKey} onSaved={done} />
      </PixelPanel>
    );
  }

  return (
    <PixelPanel title={BUTTONS.newUnit} className={className} bodyClassName="p-4">
      <form onSubmit={submit} className="space-y-4">
        <label className="block">
          <span className={labelCls}>Callsign</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} className={field} />
        </label>
        <fieldset>
          <legend className={labelCls}>{UNITS.strategyLabel}</legend>
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
            {!ownerDevice ? (
              <label
                className={cn(
                  "flex cursor-pointer items-start gap-3 border-2 px-2.5 py-2 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
                  strategy === "custom" ? "border-accent bg-accent/[0.07]" : "border-line hover:border-ink-dim",
                )}
              >
                <input type="radio" name="strategy" value="custom" checked={strategy === "custom"} onChange={() => setStrategy("custom")} className="sr-only" />
                <span className="mt-0.5 grid size-10 shrink-0 place-items-center bg-bg shadow-[inset_0_0_0_2px_var(--color-line)]">
                  <Sprite name="icon.unclassified" scale={2} />
                </span>
                <span className="min-w-0">
                  <span className={cn("block font-ui text-xs tracking-[0.08em] uppercase", strategy === "custom" ? "text-accent" : "text-ink")}>
                    {strategy === "custom" ? "▶ " : ""}
                    {UNITS.customName}
                  </span>
                  <span className="mt-0.5 block text-xs leading-snug text-ink-dim">{UNITS.customDescription}</span>
                </span>
              </label>
            ) : null}
          </div>
          {strategy === "custom" ? (
            <label className="mt-3 block">
              <span className={labelCls}>{UNITS.customLabel}</span>
              <textarea
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                maxLength={4000}
                rows={5}
                placeholder={UNITS.customPlaceholder}
                data-testid="strategy-text"
                className="w-full border-2 border-line bg-bg p-2.5 font-term text-[20px] leading-tight text-ink focus:border-accent focus:outline-none"
              />
              <span className="mt-1 block text-[11px] text-ink-dim">{UNITS.customHint}</span>
            </label>
          ) : null}
        </fieldset>
        {/* Always shown: the owner flag is also set by publishing a vault, which does not make this the
            arena owner's device, and the server then needs the key. */}
        <div className="space-y-1.5">
          <ZgConnect label={UNITS.zgLabel} compact onConnected={setZg} onCleared={() => setZg(null)} />
          <p className="text-[11px] text-ink-dim">{UNITS.zgHint}</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <HbarInput label="Budget" value={budget} onChange={setBudget} hint={ownerDevice ? "funds its own account" : UNITS.budgetHint} />
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
          {busy ? (ownerDevice ? "OPENING ACCOUNT…" : UNITS.openingDeposit) : ownerDevice ? "CREATE UNIT ▶" : UNITS.fundUnit}
        </PixelButton>
      </form>
    </PixelPanel>
  );
}
