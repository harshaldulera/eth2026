"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { ApprovalRequest, RaiderAgent } from "@/lib/types";
import { api, describeError, type AgentDetail } from "@/lib/api/client";
import { formatHbar } from "@/lib/chain/units";
import { UNITS } from "@/lib/vocab";
import { ZgCredits } from "@/components/money/zg-credits";
import { LED } from "@/components/pixel/led";
import { PixelButton } from "@/components/pixel/button";
import { playCue } from "@/components/pixel/sfx-link";
import { cn } from "@/lib/utils";
import { useHoldsOperatorKey } from "@/lib/agents/use-operator-keys";

/**
 * `FUNDED BY YOU` for a red teamer's own unit (operator-funded and its key is in this browser),
 * `SELF-FUNDED` for another red teamer's, `ARENA` for the arena's demo units.
 */
export function FundedTag({ agent, className }: { agent: Pick<RaiderAgent, "id" | "fundedBy">; className?: string }) {
  const operator = agent.fundedBy === "operator";
  const held = useHoldsOperatorKey(agent.id);
  const mine = operator && held;
  return (
    <span
      className={cn(
        "inline-block border-2 px-1.5 py-0.5 font-ui text-[10px] leading-none tracking-[0.1em] uppercase",
        mine ? "border-money/70 text-money" : operator ? "border-line text-ink" : "border-line text-ink-dim",
        className,
      )}
    >
      {mine ? UNITS.fundedByYou : operator ? UNITS.fundedByOperator : UNITS.fundedByArena}
    </span>
  );
}

/** Has the unit's own 0G key been refused? (a pending `zg_key` ask) */
export function zgKeyRejected(approvals: readonly ApprovalRequest[] | undefined, agentId: string): boolean {
  return Boolean(approvals?.some((p) => p.agentId === agentId && p.status === "pending" && p.reason === "zg_key"));
}

/** Tinybar string to "9.25 ℏ" (two decimals). */
export function hbarShort(tinybar: string): string {
  try {
    const n = Number(BigInt(tinybar)) / 1e8;
    return `${n.toFixed(2)} ℏ`;
  } catch {
    return "—";
  }
}

/**
 * The unit's money line in the mission panel: funded-by tag, BALANCE (its own account), the live
 * 0G CREDITS line, WITHDRAW (a unit you funded, idle only), and the 0G KEY REJECTED state.
 * `hideBalance`: the caller shows BALANCE itself (an operator account's hero number).
 *
 * @example <UnitFunds detail={detail} idle={!active} refresh={refresh} />
 */
export function UnitFunds({ detail, idle, refresh, hideBalance }: { detail: AgentDetail; idle: boolean; refresh: () => void; hideBalance?: boolean }) {
  const a = detail.agent;
  const [busy, setBusy] = useState(false);
  const rejected = zgKeyRejected(detail.approvals, a.id);
  const mine = a.fundedBy === "operator";
  // The unit's owner or operator may withdraw; the server checks the key.
  const canWithdraw = mine && Boolean(detail.access);
  // Nothing above the transfer-fee reserve (lib/agents/transfer WITHDRAW_RESERVE_TINYBAR, 0.1 ℏ): nothing to send.
  const empty = detail.balance !== undefined && BigInt(detail.balance) <= BigInt(10_000_000);

  async function withdraw() {
    setBusy(true);
    try {
      const r = await api.withdrawAgent(a.id);
      playCue("coin_pay");
      toast.success(UNITS.withdrawDone(formatHbar(BigInt(r.amount), { symbol: false })), { description: `Sent back to ${a.owner}.` });
      refresh();
    } catch (e) {
      toast.error(UNITS.withdrawFailed, { description: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2" data-testid="unit-funds">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <FundedTag agent={a} />
        {detail.balance !== undefined && !hideBalance ? (
          <span className="font-ui text-[11px] tracking-[0.1em] text-money uppercase tabular">
            {UNITS.balance} <span data-testid="unit-balance">{hbarShort(detail.balance)}</span>
          </span>
        ) : null}
        {a.zg?.connected ? <ZgCredits agentId={a.id} /> : null}
        {canWithdraw ? (
          <PixelButton size="sm" variant="threatOutline" className="ml-auto" onClick={() => void withdraw()} disabled={busy || !idle || empty} title={idle ? undefined : UNITS.withdrawBusy}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {busy ? UNITS.withdrawing : UNITS.withdraw}
          </PixelButton>
        ) : null}
      </div>
      {rejected ? (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-2 border-threat/60 bg-threat/[0.07] px-3 py-2">
          <LED kind="warn" label={UNITS.keyRejected} />
          <span className="text-xs text-ink-dim">{UNITS.keyRejectedHint}</span>
        </div>
      ) : null}
    </div>
  );
}
