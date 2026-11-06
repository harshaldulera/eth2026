"use client";

import { useMemo, useState } from "react";
import { Bot } from "lucide-react";
import { api } from "@/lib/api/client";
import { ArkivBar } from "@/components/arena/arkiv-bar";
import { BoardFilters, type BoardQuery } from "@/components/arena/board-filters";
import { usePolling } from "@/lib/hooks/usePolling";
import { useConfig } from "@/lib/hooks/useConfig";
import { Amount } from "@/components/money/amount";
import { AgentPanel } from "@/components/raider/agent-panel";
import { AgentStatusPill, liveStatus } from "@/components/raider/agent-bits";
import { CreateAgentForm } from "@/components/raider/create-agent-form";
import { PhoneApprovalsCard } from "@/components/raider/phone-card";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/state";
import { cn } from "@/lib/utils";

export default function RaiderPage() {
  const { config } = useConfig();
  const agents = usePolling(() => api.agents(), 2000);
  const [q, setQ] = useState<BoardQuery>({});
  // The owner picks the target from the same Arkiv query the board runs (guarding castles only).
  const castles = usePolling(() => api.castles({ tier: q.tier, sort: q.sort, minPot: q.minPot, vaultState: "guarding" }), 10000, { key: JSON.stringify(q) });
  const live = usePolling(() => api.liveSieges(), 5000);
  const underSiege = useMemo(() => new Set((live.data?.sieges ?? []).map((s) => s.castleId)), [live.data]);
  const approvals = usePolling(() => api.approvals("pending"), 2000);
  const [selected, setSelected] = useState<string | null>(null);

  const list = agents.data?.agents ?? [];
  const pending = approvals.data?.approvals ?? [];
  const current = list.find((a) => a.id === selected) ?? list[0];

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6 max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight">Raider agents</h1>
        <p className="mt-2 text-stone">
          Autonomous attackers with their own Hedera account and hard caps. When one hits a cap it stops and asks you — and only you can let it keep spending.
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <section className="min-w-0 space-y-4" aria-label="Agents">
          {agents.error && !agents.data ? (
            <ErrorState error={agents.error} onRetry={() => void agents.refresh()} title="Couldn't load agents" />
          ) : !agents.data ? (
            <Skeleton className="h-24" />
          ) : list.length === 0 ? (
            <EmptyState icon={<Bot />} title="No raider agents yet" hint="Create one with the form — it gets its own funded account and caps." />
          ) : (
            <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Your agents">
              {list.map((a) => {
                const active = current?.id === a.id;
                return (
                  <button
                    key={a.id}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setSelected(a.id)}
                    className={cn(
                      "flex min-w-[200px] flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left transition-colors",
                      active ? "border-ember/50 bg-ember/[0.05]" : "border-arena-line bg-arena-panel/70 hover:border-stone/40",
                    )}
                  >
                    <span className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-parchment">{a.name}</span>
                      <AgentStatusPill status={liveStatus(a, pending)} />
                    </span>
                    <span className="text-xs text-stone">
                      <Amount amount={a.spent} size="xs" /> spent of <Amount amount={a.budget} size="xs" tone="text-parchment/80" />
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {current ? (
            <>
              <div className="rounded-xl border border-arena-line bg-arena-panel/60 px-3 py-2.5">
                <p className="mb-2 text-xs text-stone">Pick a target. These castles come from Arkiv: the same query any raider can run.</p>
                <BoardFilters value={q} onChange={(next) => setQ({ ...next, all: false })} />
                <ArkivBar meta={castles.data?.arkiv} className="mt-2" />
              </div>
              <AgentPanel key={current.id} agentId={current.id} castles={castles.data?.castles ?? []} underSiege={underSiege} />
            </>
          ) : null}
        </section>

        <aside className="space-y-6">
          <CreateAgentForm
            onCreated={(a) => {
              setSelected(a.id);
              agents.mutate((d) => (d ? { agents: [a, ...d.agents.filter((x) => x.id !== a.id)] } : { agents: [a] }));
              void agents.refresh();
            }}
          />
          <PhoneApprovalsCard ownerKeyHint={config?.ownerKeyHint} pending={pending.length} />
        </aside>
      </div>
    </div>
  );
}
