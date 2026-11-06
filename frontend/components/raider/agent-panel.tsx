"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2, Play, Square, Swords } from "lucide-react";
import type { Castle } from "@/lib/types";
import { api, asOwner, describeError, type AgentDetail } from "@/lib/api/client";
import { usePolling, useNow } from "@/lib/hooks/usePolling";
import { toUnits } from "@/lib/money/format";
import { Amount } from "@/components/money/amount";
import { HashscanLink } from "@/components/money/hashscan-link";
import { WaitingForOwner } from "@/components/money/waiting-for-owner";
import { EventLine } from "@/components/arena/event-line";
import { SiegeStatusBadge } from "@/components/arena/tier";
import { Button } from "@/components/ui/button";
import { Card, CardBody } from "@/components/ui/card";
import { ErrorState, Loading } from "@/components/ui/state";
import { AgentStatusPill, BudgetBar, liveStatus } from "./agent-bits";

/**
 * Live view of one raider agent: caps, budget, run/stop, and its timeline (sieges, fee splits,
 * cap hits, owner decisions). Polls GET /api/agents/[id].
 *
 * @example <AgentPanel agentId={id} castles={castles} />
 */
export function AgentPanel({ agentId, castles }: { agentId: string; castles: Castle[] }) {
  const { data, error, refresh } = usePolling(() => api.agent(agentId), 1500, { key: agentId });
  if (error && !data) return <ErrorState error={error} onRetry={() => void refresh()} title="Couldn't load this agent" />;
  if (!data) return <Loading label="Loading agent…" />;
  return <AgentPanelView detail={data} castles={castles} refresh={() => void refresh()} />;
}

function AgentPanelView({ detail, castles, refresh }: { detail: AgentDetail; castles: Castle[]; refresh: () => void }) {
  const { agent: a, approvals, events, sieges } = detail;
  const status = liveStatus(a, approvals);
  const pending = approvals.find((x) => x.status === "pending");
  const openCastles = castles.filter((c) => c.status === "open");
  const [target, setTarget] = useState("");
  const [maxSieges, setMaxSieges] = useState("3");
  const [busy, setBusy] = useState<"run" | "stop" | null>(null);
  const now = useNow(5000);
  const castleId = target || openCastles[0]?.id || "";
  const names = useMemo(() => new Map(castles.map((c) => [c.id, c.name])), [castles]);
  const timeline = useMemo(() => [...events].sort((x, y) => y.id - x.id), [events]);

  async function run() {
    if (!castleId) return;
    setBusy("run");
    try {
      const n = Number.parseInt(maxSieges, 10);
      await asOwner(() => api.runAgent(a.id, { castleId, ...(Number.isFinite(n) && n > 0 ? { maxSieges: n } : {}) }));
      toast.success(`${a.name} marches on ${names.get(castleId) ?? "the castle"}`);
      refresh();
    } catch (e) {
      toast.error("Couldn't start the agent", { description: describeError(e) });
    } finally {
      setBusy(null);
    }
  }
  async function stop() {
    setBusy("stop");
    try {
      await asOwner(() => api.stopAgent(a.id));
      toast(`${a.name} stopped`);
      refresh();
    } catch (e) {
      toast.error("Couldn't stop the agent", { description: describeError(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-xl font-semibold text-parchment">{a.name}</h2>
                <AgentStatusPill status={status} />
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-stone">
                <span className="capitalize">{a.strategy}</span> · account <HashscanLink accountId={a.accountId} />
              </p>
            </div>
            <div className="text-right">
              <p className="text-[11px] tracking-[0.14em] text-stone uppercase">Left</p>
              <Amount amount={(toUnits(a.budget) - toUnits(a.spent)).toString()} size="xl" />
            </div>
          </div>

          <BudgetBar spent={a.spent} budget={a.budget} />

          <dl className="grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-lg border border-arena-line px-2.5 py-2">
              <dt className="text-stone">Per castle</dt>
              <dd>
                <Amount amount={a.perCastleCap} size="sm" animate={false} />
              </dd>
            </div>
            <div className="rounded-lg border border-arena-line px-2.5 py-2">
              <dt className="text-stone">Daily</dt>
              <dd>
                <Amount amount={a.dailyCap} size="sm" animate={false} />
              </dd>
            </div>
            <div className="rounded-lg border border-arena-line px-2.5 py-2">
              <dt className="text-stone">Losses</dt>
              <dd className="tabular text-sm text-parchment">
                {a.consecutiveLosses}
                <span className="text-stone">/{a.stopAfterLosses}</span>
              </dd>
            </div>
          </dl>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex-1 text-xs text-stone">
              Target castle
              <select
                value={castleId}
                onChange={(e) => setTarget(e.target.value)}
                disabled={openCastles.length === 0}
                className="mt-1 h-10 w-full rounded-lg border border-arena-line bg-arena-bg/60 px-2.5 text-sm text-parchment focus:border-gold/50 focus:outline-none"
              >
                {openCastles.length === 0 ? <option value="">No open castles</option> : null}
                {openCastles.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} — {c.tier}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-stone sm:w-24">
              Sieges
              <input
                value={maxSieges}
                onChange={(e) => setMaxSieges(e.target.value)}
                inputMode="numeric"
                className="tabular mt-1 h-10 w-full rounded-lg border border-arena-line bg-arena-bg/60 px-2.5 text-sm text-parchment focus:border-gold/50 focus:outline-none"
              />
            </label>
            {status === "running" || status === "waiting" ? (
              <Button variant="ember" size="lg" onClick={() => void stop()} disabled={busy !== null}>
                {busy === "stop" ? <Loader2 className="animate-spin" /> : <Square />} Stop
              </Button>
            ) : (
              <Button variant="emberSolid" size="lg" onClick={() => void run()} disabled={busy !== null || !castleId}>
                {busy === "run" ? <Loader2 className="animate-spin" /> : <Play />} Run
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      {pending ? <WaitingForOwner approval={pending} /> : null}

      <Card>
        <div className="border-b border-arena-line px-4 py-3 text-xs font-semibold tracking-[0.14em] text-stone uppercase">Timeline</div>
        {timeline.length === 0 ? (
          <CardBody>
            <p className="text-sm text-stone">Nothing yet. Pick a castle and press Run — the agent pays each siege fee from its own account.</p>
          </CardBody>
        ) : (
          <ul className="max-h-[480px] space-y-3 overflow-y-auto p-4">
            {timeline.map((e) => (
              <li key={e.id}>
                <EventLine event={e} castleName={(id) => (id ? names.get(id) : undefined)} now={now} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      {sieges.length ? (
        <Card>
          <div className="flex items-center gap-2 border-b border-arena-line px-4 py-3 text-xs font-semibold tracking-[0.14em] text-stone uppercase">
            <Swords className="size-3.5" /> Sieges
          </div>
          <ul className="divide-y divide-arena-line">
            {sieges.slice(0, 10).map((s) => (
              <li key={s.id}>
                <Link href={`/siege/${s.id}`} className="flex items-center gap-3 px-4 py-2.5 text-sm hover:bg-white/[0.02]">
                  <SiegeStatusBadge status={s.status} className="w-24 justify-center" />
                  <span className="min-w-0 flex-1 truncate text-parchment/85">{names.get(s.castleId) ?? s.castleId}</span>
                  <span className="tabular text-xs text-stone">{s.turn}/5</span>
                  {s.receipt && !s.receipt.free ? <Amount amount={s.receipt.amount} size="xs" animate={false} /> : null}
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
