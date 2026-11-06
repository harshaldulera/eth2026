"use client";

import type * as React from "react";
import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { RaiderAgent } from "@/lib/types";
import { api, describeError, type CreateUnitResponse } from "@/lib/api/client";
import { promoteDraftKey, saveDraftKey } from "@/lib/agents/operator-keys";
import { randomCallsign } from "@/lib/agents/manual";
import { hbarToTinybar } from "@/lib/chain/units";
import { useConfig } from "@/lib/hooks/useConfig";
import { formatAmount } from "@/lib/money/format";
import { UNITS } from "@/lib/vocab";
import { DepositPanel } from "@/components/money/deposit-panel";
import { PixelButton } from "@/components/pixel/button";
import { PixelPanel } from "@/components/pixel/panel";
import { playCue } from "@/components/pixel/sfx-link";
import { OperatorKeyDialog } from "./operator-key-dialog";
import { cn } from "@/lib/utils";

const field =
  "min-h-11 w-full border-2 border-line bg-bg px-2.5 font-term text-[20px] leading-none text-ink focus:border-accent focus:outline-none disabled:opacity-60";
const labelCls = "mb-1 block font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase";

/** Fallback minimum until /api/config arrives (the server default, 1 ℏ). */
const DEFAULT_MIN = "100000000";
const DEFAULT_AMOUNT = "5";

type Created = Extract<CreateUnitResponse, { draft: unknown }>;

/**
 * FUND YOUR OPERATOR ACCOUNT: the red teamer's own money for the ops they type by hand. Amount
 * (default 5 ℏ, min UNIT_MIN_BUDGET) + optional callsign -> POST /api/agents {kind: "manual"} ->
 * the deposit panel (memo transfer from their wallet; stub auto-confirms) -> the operator key, shown
 * once (also kept in localStorage siege.operatorKeys) -> `onFunded(account)`. No 0G key, no strategy:
 * the account pays ops, it never runs on its own.
 *
 * @example <FundOperatorAccount onFunded={(a) => payFrom(a)} onCancel={() => setOpen(false)} />
 */
export function FundOperatorAccount({
  onFunded,
  onCancel,
  className,
  panelRef,
}: {
  onFunded: (account: RaiderAgent) => void;
  onCancel?: () => void;
  className?: string;
  panelRef?: React.Ref<HTMLDivElement>;
}) {
  const { config } = useConfig();
  const min = BigInt(config?.unitMinBudget ?? DEFAULT_MIN);
  const minLabel = formatAmount(min);
  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  // Prefilled with a real callsign (blank used to name the account "Unit"). Rendered only after a click.
  const [callsign, setCallsign] = useState(() => randomCallsign());
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [saved, setSaved] = useState<RaiderAgent | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    let budget: bigint;
    try {
      budget = hbarToTinybar(amount);
    } catch {
      return toast.error("Amount must be an HBAR value (up to 8 decimals)");
    }
    if (budget < min) return toast.error(`At least ${minLabel}`);
    setBusy(true);
    try {
      const res = await api.createUnit({ kind: "manual", name: callsign.trim() || undefined, budget: budget.toString() });
      if (!("draft" in res)) throw new Error("The arena opened an arena-funded unit instead of your account.");
      // The key is shown once: keep it in this browser the moment it arrives.
      saveDraftKey(res.draft.id, res.operatorKey);
      setCreated(res);
    } catch (err) {
      toast.error("Couldn't open the deposit", { description: describeError(err) });
    } finally {
      setBusy(false);
    }
  }

  // The deposit landed and the account exists: show the operator key once.
  async function funded() {
    if (!created) return;
    try {
      const { agent } = await api.agentDraft(created.draft.id);
      if (!agent) throw new Error("The account is not open yet.");
      promoteDraftKey(created.draft.id, agent.id);
      playCue("ui_confirm");
      setSaved(agent);
    } catch (err) {
      toast.error("Couldn't open the account yet", { description: describeError(err) });
    }
  }

  function done() {
    const a = saved;
    if (!a) return;
    setSaved(null);
    setCreated(null);
    toast.success(UNITS.accountFunded, { description: UNITS.accountReady(a.name) });
    onFunded(a);
  }

  return (
    <div ref={panelRef} className={cn("scroll-my-4", className)} data-testid="fund-operator-account">
      {created ? (
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-ink-dim">{UNITS.accountDepositHint}</p>
          <DepositPanel key={created.deposit.intentId} intentId={created.deposit.intentId} onFunded={() => void funded()} />
          {onCancel ? (
            // Back out without losing anything: the key is already saved in this browser, so a deposit that
            // lands later still opens the account (GET /api/agents?mine finds it by that key).
            <PixelButton type="button" variant="ghost" size="lg" className="w-full" onClick={onCancel} data-testid="account-later">
              {UNITS.depositLater}
            </PixelButton>
          ) : null}
          <OperatorKeyDialog open={Boolean(saved)} operatorKey={created.operatorKey} onSaved={done} body={UNITS.keyBodyAccount} />
        </div>
      ) : (
        <PixelPanel title={UNITS.accountTitle} tone="money" bodyClassName="p-4">
          <form onSubmit={submit} className="space-y-3">
            <p className="text-sm leading-relaxed text-ink-dim">{UNITS.accountHint}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={labelCls}>{UNITS.accountAmount}</span>
                <span className="relative block">
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    data-testid="account-amount"
                    className={cn(field, "tabular pr-8 text-money")}
                  />
                  <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-money/80">ℏ</span>
                </span>
                <span className="mt-1 block text-[11px] text-ink-dim">{UNITS.accountMin(minLabel)}</span>
              </label>
              <label className="block">
                <span className={labelCls}>{UNITS.accountCallsign}</span>
                <input value={callsign} onChange={(e) => setCallsign(e.target.value)} maxLength={40} className={field} data-testid="account-callsign" />
              </label>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <PixelButton type="submit" variant="money" size="lg" className="w-full sm:flex-1" disabled={busy} cue={null} data-testid="account-open">
                {busy ? <Loader2 className="animate-spin" /> : null}
                {busy ? UNITS.openingDeposit : UNITS.openAccount}
              </PixelButton>
              {onCancel ? (
                <PixelButton type="button" variant="ghost" size="lg" onClick={onCancel} disabled={busy}>
                  {UNITS.accountCancel}
                </PixelButton>
              ) : null}
            </div>
          </form>
        </PixelPanel>
      )}
    </div>
  );
}
