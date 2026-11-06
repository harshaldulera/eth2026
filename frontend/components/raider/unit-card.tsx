"use client";

import type { ApprovalRequest, RaiderAgent } from "@/lib/types";
import { api, type AgentDetail } from "@/lib/api/client";
import { useNow, usePolling } from "@/lib/hooks/usePolling";
import { Sprite } from "@/components/pixel/sprite";
import { mmss } from "@/components/money/waiting-for-owner";
import { cn } from "@/lib/utils";
import { AgentStatusPill, Gauge, LossLeds, liveStatus, unitGauges } from "./agent-bits";

export type UnitCardProps = {
  agent: RaiderAgent;
  /** The selected unit's detail (the page polls it); other units poll their own, slower. */
  detail?: AgentDetail;
  /** Pending approvals across all units (from the page's poll), for the status light. */
  pending?: ApprovalRequest[];
  selected?: boolean;
  onSelect?: () => void;
  className?: string;
};

/**
 * One agent as a unit on the rail: hooded operator sprite, name, status light, the three cap gauges
 * (PER-VAULT / DAILY / TOTAL) and the stop-rule loss lights. A tab: selecting it opens its mission.
 *
 * @example <UnitCard agent={a} detail={selectedDetail} selected onSelect={() => setSelected(a.id)} />
 */
export function UnitCard({ agent, detail: given, pending, selected, onSelect, className }: UnitCardProps) {
  const own = usePolling(() => api.agent(agent.id), 4000, { key: agent.id, enabled: !given });
  const detail = given ?? own.data;
  const a = detail?.agent ?? agent;
  const approvals = detail?.approvals ?? pending?.filter((p) => p.agentId === a.id) ?? [];
  const status = liveStatus(a, approvals);
  const waitingSince = approvals.find((p) => p.status === "pending")?.createdAt;
  const now = useNow(1000, status === "waiting");
  const wait = status === "waiting" && waitingSince && now > 0 ? mmss((now - Date.parse(waitingSince)) / 1000) : undefined;
  const g = unitGauges(a, detail?.sieges, approvals);

  return (
    <div
      className={cn(
        "group relative flex w-full flex-col gap-3 bg-panel p-3 text-left px-frame transition-[filter] has-[button:hover]:brightness-110 has-[button:focus-visible]:outline-2 has-[button:focus-visible]:outline-offset-4 has-[button:focus-visible]:outline-accent",
        selected && "bg-raised [--frame:color-mix(in_oklab,var(--color-accent)_70%,var(--color-line))]",
        status === "waiting" && !selected && "[--frame:color-mix(in_oklab,var(--color-warn)_60%,var(--color-line))]",
        className,
      )}
    >
      {/* the whole card is the tab; the gauges below are read-only and sit above it without catching clicks */}
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        aria-label={`${a.name}: ${status === "waiting" ? "waiting for owner" : status}`}
        onClick={onSelect}
        className="absolute inset-0 z-0 cursor-pointer focus:outline-none"
      />
      {selected ? <span aria-hidden className="absolute top-2 bottom-2 -left-[6px] w-[3px] bg-accent shadow-[0_0_8px_var(--color-accent)]" /> : null}
      <span className="pointer-events-none relative flex items-center gap-3">
        <span className="grid size-14 shrink-0 place-items-center bg-bg/70 shadow-[inset_0_0_0_2px_var(--color-line)]">
          <Sprite name={status === "running" ? "operator.think" : "operator.idle"} animate={status === "running" || status === "waiting"} scale={3} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-ui text-sm tracking-[0.04em] text-ink uppercase">{a.name}</span>
          <span className="mt-0.5 block truncate text-[11px] text-ink-dim">strategy {a.strategy}</span>
          <AgentStatusPill status={status} waitingFor={wait} className="mt-1.5 whitespace-normal [&>span:last-child]:leading-tight" />
        </span>
      </span>
      <div className="pointer-events-none relative flex flex-col gap-1.5">
        <Gauge label="Per-vault" spent={g.perVault.spent} cap={g.perVault.cap} />
        <Gauge label="Daily" spent={g.daily.spent} cap={g.daily.cap} />
        <Gauge label="Total" spent={g.total.spent} cap={g.total.cap} />
        <LossLeds losses={a.consecutiveLosses} stopAfter={a.stopAfterLosses} />
      </div>
    </div>
  );
}
