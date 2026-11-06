"use client";

import type { ApprovalRequest, Asset, RaiderAgent, Siege } from "@/lib/types";
import { HBAR, toNumber, toUnits } from "@/lib/money/format";
import { LED as LED_TEXT } from "@/lib/vocab";
import { LED } from "@/components/pixel/led";
import { Meter } from "@/components/pixel/meter";
import { cn } from "@/lib/utils";

export type AgentLiveStatus = "running" | "waiting" | "stopped" | "idle";

/** Status as the owner thinks of it: a paused agent with a pending approval is "waiting for owner". */
export function liveStatus(agent: RaiderAgent, approvals?: ApprovalRequest[]): AgentLiveStatus {
  const waiting = agent.status === "paused" || approvals?.some((a) => a.agentId === agent.id && a.status === "pending");
  if (waiting && agent.status !== "stopped") return "waiting";
  if (agent.status === "running") return "running";
  if (agent.status === "stopped") return "stopped";
  return "idle";
}

/**
 * Unit status light: `RUNNING` red pulse, `WAITING FOR OWNER 00:12` amber blink, `STOPPED` grey,
 * `IDLE`. Pass `waitingFor` (mm:ss) to show the wait clock.
 *
 * @example <AgentStatusPill status={liveStatus(agent)} />
 */
export function AgentStatusPill({ status, waitingFor, className }: { status: AgentLiveStatus; waitingFor?: string; className?: string }) {
  switch (status) {
    case "running":
      return <LED kind="live" label={LED_TEXT.running} className={className} />;
    case "waiting":
      return <LED kind="warn" label={LED_TEXT.waitingForOwner(waitingFor)} className={className} />;
    case "stopped":
      return <LED kind="idle" label={LED_TEXT.stopped} blink={false} className={cn("opacity-80", className)} />;
    default:
      return <LED kind="idle" label={LED_TEXT.idle} className={cn("text-ink", className)} />;
  }
}

/** `1.5/2 ℏ` with no trailing zeros. */
function shortHbar(units: bigint, asset: Asset = HBAR): string {
  const n = toNumber(units.toString(), asset);
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, "");
}

/**
 * Spent vs budget as an 8-cell gauge (the TOTAL gauge).
 *
 * @example <BudgetBar spent={agent.spent} budget={agent.budget} />
 */
export function BudgetBar({ spent, budget, asset = HBAR, className }: { spent: string; budget: string; asset?: Asset; className?: string }) {
  return <Gauge label="Total" spent={toUnits(spent)} cap={toUnits(budget)} asset={asset} className={className} />;
}

/**
 * One cap gauge: `PER-VAULT ▮▮▮▮▯▯▯▯ 1/2 ℏ`. Money-coloured until the cap is reached, then the
 * attack colour (the unit is about to radio its owner).
 */
export function Gauge({ label, spent, cap, asset = HBAR, className }: { label: string; spent: bigint; cap: bigint; asset?: Asset; className?: string }) {
  const full = cap > BigInt(0) && spent >= cap;
  const s = toNumber(spent.toString(), asset);
  const c = toNumber(cap.toString(), asset);
  return (
    <div className={cn("grid grid-cols-[70px_1fr] items-center gap-2", className)}>
      <span className="font-ui text-[10px] tracking-[0.04em] whitespace-nowrap text-ink-dim uppercase">{label}</span>
      <Meter
        value={Math.min(s, c)}
        max={c > 0 ? c : 1}
        cells={8}
        size="sm"
        tone={full ? "threat" : "money"}
        label={`${label} spent`}
        valueText={
          <span className={cn("text-[11px]", full ? "text-threat" : "text-ink")}>
            {shortHbar(spent, asset)}/{shortHbar(cap, asset)} ℏ
          </span>
        }
      />
    </div>
  );
}

/**
 * Loss LEDs for the stop rule: `LOSSES ●●○ 2/3`. Up to 10 lights; more than that shows the count only.
 */
export function LossLeds({ losses, stopAfter, className }: { losses: number; stopAfter: number; className?: string }) {
  const n = Math.max(0, stopAfter);
  const lit = Math.min(losses, n);
  return (
    <div className={cn("grid grid-cols-[70px_1fr] items-center gap-2", className)} role="meter" aria-label="Losses before the stop rule" aria-valuemin={0} aria-valuemax={n} aria-valuenow={lit}>
      <span className="font-ui text-[10px] tracking-[0.04em] whitespace-nowrap text-ink-dim uppercase">Losses</span>
      <span className="flex items-center gap-2">
        {n <= 10 ? (
          <span className="flex gap-[3px]" aria-hidden>
            {Array.from({ length: n }, (_, i) => (
              <span key={i} className={cn("size-2", i < lit ? "bg-threat shadow-[0_0_5px_-1px_currentColor] text-threat" : "bg-line/60")} />
            ))}
          </span>
        ) : null}
        <span className={cn("tabular font-ui text-[11px]", lit >= n && n > 0 ? "text-threat" : "text-ink")}>
          {lit}/{n}
        </span>
      </span>
    </div>
  );
}

// ─── gauges from an agent's detail ────────────────────────────────────────────────────────

export type UnitGauges = {
  /** The vault the PER-VAULT gauge is about (pending request → newest op → target). */
  vaultId?: string;
  perVault: { spent: bigint; cap: bigint };
  daily: { spent: bigint; cap: bigint };
  total: { spent: bigint; cap: bigint };
  /** Paid ops on that vault in the recent window. */
  vaultOps: number;
};

const utcDay = (iso: string) => iso.slice(0, 10);

/**
 * The three cap gauges, rebuilt client-side the same way `lib/pay/caps.ts` decides: paid ops
 * (not refunded) against the cap plus any approved top-up of that kind. Uses the agent's recent
 * ops (the API returns the last 20), so on a long-running unit it can under-count; the server
 * still enforces the real cap.
 */
export function unitGauges(
  agent: RaiderAgent,
  sieges: Siege[] = [],
  approvals: ApprovalRequest[] = [],
  targetId?: string,
  now: number = Date.now(),
): UnitGauges {
  const pending = approvals.find((a) => a.status === "pending");
  const vaultId = pending?.castleId ?? sieges[0]?.castleId ?? targetId;
  const paid = sieges.filter((s) => s.receipt && !s.receipt.free && s.settlement?.state !== "void");
  const amt = (s: Siege) => (s.receipt && !s.receipt.free ? toUnits(s.receipt.amount) : BigInt(0));
  const sum = (xs: bigint[]) => xs.reduce((t, x) => t + x, BigInt(0));
  const today = new Date(now).toISOString().slice(0, 10);

  const onVault = paid.filter((s) => s.castleId === vaultId);
  const vaultAllow = approvals.filter((a) => a.status === "approved" && a.reason === "per_castle" && a.castleId === vaultId);
  const dayAllow = approvals.filter((a) => a.status === "approved" && a.reason === "daily" && a.resolvedAt && utcDay(a.resolvedAt) === today);

  return {
    vaultId,
    perVault: { spent: sum(onVault.map(amt)), cap: toUnits(agent.perCastleCap) + sum(vaultAllow.map((a) => toUnits(a.amount))) },
    daily: { spent: sum(paid.filter((s) => utcDay(s.createdAt) === today).map(amt)), cap: toUnits(agent.dailyCap) + sum(dayAllow.map((a) => toUnits(a.amount))) },
    total: { spent: toUnits(agent.spent), cap: toUnits(agent.budget) },
    vaultOps: onVault.length,
  };
}
