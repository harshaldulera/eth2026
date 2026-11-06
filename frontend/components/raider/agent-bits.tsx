"use client";

import { motion } from "motion/react";
import type { ApprovalRequest, Asset, RaiderAgent } from "@/lib/types";
import { HBAR, toUnits } from "@/lib/money/format";
import { Amount } from "@/components/money/amount";
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

/** @example <AgentStatusPill status={liveStatus(agent)} /> */
export function AgentStatusPill({ status, className }: { status: AgentLiveStatus; className?: string }) {
  const map = {
    running: { label: "Running", cls: "border-ember/40 bg-ember/10 text-ember", dot: "bg-ember animate-pulse" },
    waiting: { label: "Waiting for owner", cls: "border-gold/50 bg-gold/10 text-gold", dot: "bg-gold animate-pulse" },
    stopped: { label: "Stopped", cls: "border-arena-line bg-white/[0.03] text-stone", dot: "bg-stone" },
    idle: { label: "Idle", cls: "border-arena-line bg-white/[0.03] text-parchment/75", dot: "bg-parchment/50" },
  }[status];
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap", map.cls, className)}>
      <span className={cn("size-1.5 rounded-full", map.dot)} aria-hidden />
      {map.label}
    </span>
  );
}

/**
 * Spent vs budget bar.
 *
 * @example <BudgetBar spent={agent.spent} budget={agent.budget} />
 */
export function BudgetBar({ spent, budget, asset = HBAR, className }: { spent: string; budget: string; asset?: Asset; className?: string }) {
  const b = toUnits(budget);
  const s = toUnits(spent);
  const pct = b > BigInt(0) ? Math.min(100, Number((s * BigInt(1000)) / b) / 10) : 0;
  return (
    <div className={cn("w-full", className)}>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-stone">
          Spent <Amount amount={spent} asset={asset} size="xs" />
        </span>
        <span className="text-stone">
          of <Amount amount={budget} asset={asset} size="xs" tone="text-parchment/85" />
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-arena-line/70" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Budget spent">
        <motion.div
          className={cn("h-full rounded-full", pct >= 80 ? "bg-ember" : "bg-gold")}
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
        />
      </div>
    </div>
  );
}
