"use client";

import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { useHasOperatorKeys } from "@/lib/agents/use-operator-keys";
import { api } from "@/lib/api/client";
import { ArkivBar } from "@/components/arena/arkiv-bar";
import { BoardFilters, type BoardQuery } from "@/components/arena/board-filters";
import { usePolling } from "@/lib/hooks/usePolling";
import { useConfig } from "@/lib/hooks/useConfig";
import { EMPTY, UNITS } from "@/lib/vocab";
import { OWNER_EVT, OWNER_FLAG } from "@/lib/publish/form";
import { MissionPanel } from "@/components/raider/agent-panel";
import { CreateAgentForm } from "@/components/raider/create-agent-form";
import { HandleClaim } from "@/components/raider/handle-claim";
import { PhoneApprovalsCard } from "@/components/raider/phone-card";
import { UnitCard } from "@/components/raider/unit-card";
import { PixelPanel } from "@/components/pixel/panel";
import { Sprite } from "@/components/pixel/sprite";
import { ErrorState, Loading, Skeleton } from "@/components/ui/state";

function subscribeOwner(cb: () => void) {
  window.addEventListener(OWNER_EVT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(OWNER_EVT, cb);
    window.removeEventListener("storage", cb);
  };
}
function readOwnerFlag(): boolean {
  try {
    return localStorage.getItem(OWNER_FLAG) === "1";
  } catch {
    return false;
  }
}

/**
 * Operator console: units on the left rail, the selected unit's mission in the centre, NEW UNIT and
 * the owner pager link on the right. Phone: one column, units first.
 */
export default function RaiderPage() {
  const { config } = useConfig();
  const agents = usePolling(() => api.agents(), 2000);
  const [q, setQ] = useState<BoardQuery>({});
  // The owner picks the target from the same Arkiv query the board runs (guarding vaults only).
  const castles = usePolling(() => api.castles({ tier: q.tier, sort: q.sort, minPot: q.minPot, vaultState: "guarding" }), 10000, { key: JSON.stringify(q) });
  // Names for the mission log and op list: every vault, so one that just broke still has its name.
  const allVaults = usePolling(() => api.castles({}), 15000, { key: "all-vaults" });
  const live = usePolling(() => api.liveSieges(), 5000);
  const underSiege = useMemo(() => new Set((live.data?.sieges ?? []).map((s) => s.castleId)), [live.data]);
  const approvals = usePolling(() => api.approvals("pending"), 2000);
  const [selected, setSelected] = useState<string | null>(null);
  const [radio, setRadio] = useState(0);
  const onRadio = useCallback(() => setRadio((n) => n + 1), []);

  // 2b: the units this browser holds operator keys for come first ("my units"), then the arena's.
  const keyed = useHasOperatorKeys();
  const mine = usePolling(() => api.agents({ mine: true }), 3000, { key: "mine", enabled: keyed });
  const mineIds = useMemo(() => new Set((mine.data?.agents ?? []).map((a) => a.id)), [mine.data]);
  const list = useMemo(() => {
    const all = agents.data?.agents ?? [];
    return [...all.filter((a) => mineIds.has(a.id)), ...all.filter((a) => !mineIds.has(a.id))];
  }, [agents.data, mineIds]);
  const pending = approvals.data?.approvals ?? [];
  // A first-time visitor lands on NEW UNIT, not on someone else's unit; the arena owner's device and a
  // red teamer with units of their own open the first one.
  const ownerDevice = useSyncExternalStore(subscribeOwner, readOwnerFlag, () => false);
  const holdsNone = mineIds.size === 0 && !ownerDevice;
  const current = list.find((a) => a.id === selected) ?? (holdsNone ? undefined : list[0]);
  const detail = usePolling(() => api.agent(current?.id ?? ""), 1500, { key: current?.id ?? "", enabled: Boolean(current) });

  const targeting = (
    <>
      <p className="text-xs text-ink-dim">Vaults come from Arkiv: the same query any operator can run.</p>
      <BoardFilters value={q} onChange={(next) => setQ({ ...next, all: false })} />
      <ArkivBar meta={castles.data?.arkiv} />
    </>
  );

  return (
    <div className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 flex items-end gap-4">
        <span className="hidden shrink-0 bg-panel p-1.5 px-frame sm:block">
          <Sprite name="operator.idle" animate scale={3} />
        </span>
        <div className="max-w-2xl">
          <p className="font-ui text-[11px] tracking-[0.2em] text-accent uppercase">Agents</p>
          <h1 className="text-2xl tracking-tight sm:text-3xl">Operator console</h1>
          <p className="mt-1.5 text-sm text-ink-dim sm:text-base">
            Units run ops on their own Hedera account with hard caps. A cap hit radios the owner — only the owner can let a unit keep spending.
          </p>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)] xl:grid-cols-[290px_minmax(0,1fr)_340px]">
        <section aria-label="Units" className="min-w-0">
          <h2 className="mb-2 flex items-center justify-between font-ui text-[11px] tracking-[0.16em] text-ink-dim uppercase">
            <span>Units</span>
            {list.length ? <span className="tabular">{String(list.length).padStart(2, "0")}</span> : null}
          </h2>
          {agents.error && !agents.data ? (
            <ErrorState error={agents.error} onRetry={() => void agents.refresh()} title="Couldn't load units" />
          ) : !agents.data ? (
            <Skeleton className="h-56" />
          ) : list.length === 0 ? (
            <PixelPanel tone="inset" className="flex flex-col items-center gap-2 px-4 py-8 text-center">
              <Sprite name="operator.idle" scale={3} />
              <p className="font-ui text-sm text-ink uppercase">{EMPTY.noUnits.title}</p>
              <p className="text-sm text-ink-dim">{EMPTY.noUnits.body}</p>
            </PixelPanel>
          ) : (
            <div
              className="-mx-4 flex snap-x scroll-px-4 gap-3 overflow-x-auto px-4 pt-1.5 pb-2 lg:mx-0 lg:flex-col lg:gap-4 lg:overflow-visible lg:px-1.5"
              role="tablist"
              aria-label="Your units"
              aria-orientation="vertical"
            >
              {list.map((a, i) => (
                <div key={a.id} className="contents">
                  {mineIds.size > 0 && (i === 0 || i === mineIds.size) ? (
                    <p className="hidden font-ui text-[10px] tracking-[0.16em] text-ink-dim uppercase lg:block">{i === 0 ? UNITS.myUnits : UNITS.arenaUnits}</p>
                  ) : null}
                <UnitCard
                  agent={a}
                  pending={pending}
                  detail={current?.id === a.id ? detail.data : undefined}
                  selected={current?.id === a.id}
                  onSelect={() => setSelected(a.id)}
                  className="w-[272px] shrink-0 snap-start lg:w-full"
                />
                </div>
              ))}
            </div>
          )}
        </section>

        <section aria-label="Mission" className="min-w-0">
          {current ? (
            detail.error && !detail.data ? (
              <ErrorState error={detail.error} onRetry={() => void detail.refresh()} title="Couldn't load this unit" />
            ) : detail.data ? (
              <MissionPanel
                key={current.id}
                detail={detail.data}
                castles={castles.data?.castles ?? []}
                vaultNames={allVaults.data?.castles}
                underSiege={underSiege}
                targeting={targeting}
                onRadio={onRadio}
                refresh={() => void detail.refresh()}
              />
            ) : (
              <Loading label="Opening mission…" />
            )
          ) : agents.data ? (
            <PixelPanel tone="inset" className="p-6 text-sm text-ink-dim">
              {UNITS.noUnitSelected}
            </PixelPanel>
          ) : null}
        </section>

        <aside
          className={`min-w-0 space-y-6 lg:order-none lg:col-span-2 lg:grid lg:grid-cols-2 lg:gap-6 lg:space-y-0 xl:col-span-1 xl:block xl:space-y-6 ${holdsNone ? "order-first" : ""}`}
        >
          <div id="new-unit" className="scroll-mt-20">
            <CreateAgentForm
              taken={list.map((x) => x.name)}
              onCreated={(a) => {
                setSelected(a.id);
                agents.mutate((d) => (d ? { agents: [a, ...d.agents.filter((x) => x.id !== a.id)] } : { agents: [a] }));
                void agents.refresh();
              }}
            />
          </div>
          <PhoneApprovalsCard ownerKeyHint={config?.ownerKeyHint} pending={pending.length} pulse={radio} />
          <HandleClaim />
        </aside>
      </div>
    </div>
  );
}
