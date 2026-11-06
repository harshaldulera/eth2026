"use client";

import type * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { ApprovalRequest, Castle, Siege } from "@/lib/types";
import { api, describeError, type AgentDetail } from "@/lib/api/client";
import { useNow, usePolling } from "@/lib/hooks/usePolling";
import { toUnits } from "@/lib/money/format";
import { vaultStateOf } from "@/lib/money/vault";
import { BUTTONS, EMPTY, UNITS, statusLabel, tierLabel } from "@/lib/vocab";
import { Amount } from "@/components/money/amount";
import { HashscanLink } from "@/components/money/hashscan-link";
import { WaitingForOwner } from "@/components/money/waiting-for-owner";
import { askText } from "@/components/money/approval-card";
import { PixelButton } from "@/components/pixel/button";
import { LED } from "@/components/pixel/led";
import { PixelPanel } from "@/components/pixel/panel";
import { Pips } from "@/components/pixel/pips";
import { playCue } from "@/components/pixel/sfx-link";
import { ErrorState, Loading } from "@/components/ui/state";
import { cn } from "@/lib/utils";
import { AgentStatusPill, liveStatus, unitGauges } from "./agent-bits";
import { MissionLog } from "./mission-log";
import { UnitFunds } from "./unit-funds";
import { useOwnerGate } from "./owner-gate";
import { isManualUnit } from "@/lib/agents/manual";

export type AgentPanelProps = {
  agentId: string;
  castles: Castle[];
  /** Every vault (any state), for names in the log and op list: a vault that just broke leaves `castles`. */
  vaultNames?: Castle[];
  underSiege?: Set<string>;
  /** Targeting controls above the select (the board's Arkiv filters and source bar). */
  targeting?: React.ReactNode;
  /** A new cap hit was radioed in (the console pulses the pager QR). */
  onRadio?: () => void;
};

/**
 * The mission panel for one unit. Polls GET /api/agents/[id] itself; when the page already polls
 * the detail, render `MissionPanel` with it instead.
 *
 * @example <AgentPanel agentId={id} castles={castles} />
 */
export function AgentPanel({ agentId, ...rest }: AgentPanelProps) {
  const { data, error, refresh } = usePolling(() => api.agent(agentId), 1500, { key: agentId });
  if (error && !data) return <ErrorState error={error} onRetry={() => void refresh()} title="Couldn't load this unit" />;
  if (!data) return <Loading label="Opening mission…" />;
  return <MissionPanel key={agentId} detail={data} refresh={() => void refresh()} {...rest} />;
}

type Resolution = { approval: ApprovalRequest; live: boolean };

/**
 * Watches a unit's approvals and plays the radio: a new pending request → `radio_call` (+ onRadio);
 * a request decided while watching → `deny` or `coin_pay`. Nothing plays for history on first load.
 */
function useComms(approvals: ApprovalRequest[], onRadio?: () => void): Resolution | null {
  const seen = useRef<Map<string, ApprovalRequest["status"]> | null>(null);
  const [live, setLive] = useState<string | null>(null);
  const now = useNow(30_000);

  useEffect(() => {
    const prev = seen.current;
    const next = new Map(approvals.map((a) => [a.id, a.status] as const));
    seen.current = next;
    if (!prev) return; // first look: history, not news
    for (const a of approvals) {
      const before = prev.get(a.id);
      if (a.status === "pending" && before === undefined) {
        playCue("radio_call");
        onRadio?.();
      } else if (before === "pending" && a.status !== "pending") {
        playCue(a.status === "approved" ? "coin_pay" : "deny");
        setLive(a.id);
      }
    }
  }, [approvals, onRadio]);

  const latest = approvals
    .filter((a) => a.status !== "pending" && a.resolvedAt)
    .sort((x, y) => (y.resolvedAt ?? "").localeCompare(x.resolvedAt ?? ""))[0];
  if (!latest || approvals.some((a) => a.status === "pending")) return null;
  // Older decisions stay in the log; the resolution strip is for the last one (15 min).
  const fresh = latest.id === live || (now > 0 && now - Date.parse(latest.resolvedAt ?? "") < 15 * 60_000);
  return fresh ? { approval: latest, live: latest.id === live } : null;
}

/** `DENIED · NIGHT SAPPER STOPPED · SALTMARSH KEEP STANDS` / `APPROVED · +2.00 ℏ TOP-UP ↗ · RESUMING`. */
function ResolutionLine({ r, running }: { r: Resolution; running: boolean }) {
  const a = r.approval;
  const approved = a.status === "approved";
  const ask = askText(a.amount);
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1.5 border-2 px-3 py-2.5 font-ui text-xs tracking-[0.08em] uppercase sm:text-sm",
        approved ? "border-safe/60 bg-safe/[0.07] text-safe" : "border-threat/60 bg-threat/[0.07] text-threat",
        r.live && "animate-[px-pop_220ms_steps(4)_1]",
      )}
    >
      {approved ? (
        <>
          <span>Approved</span>
          <span aria-hidden className="text-ink-dim">·</span>
          {a.topUp ? (
            <HashscanLink tx={a.topUp} label={`+${ask.num} ${ask.unit} top-up`} />
          ) : (
            <span className="text-money">
              +{ask.num} {ask.unit} {a.reason === "budget" ? "top-up" : UNITS.capRaised}
            </span>
          )}
          <span aria-hidden className="text-ink-dim">·</span>
          <span className={running ? "text-safe" : "text-ink-dim"}>{running ? "Resuming" : "Cleared to resume"}</span>
        </>
      ) : (
        <>
          <span>Denied</span>
          <span aria-hidden className="text-ink-dim">·</span>
          <span>{a.agentName} stopped</span>
          <span aria-hidden className="text-ink-dim">·</span>
          <span className="text-ink">{a.castleName} stands</span>
        </>
      )}
    </div>
  );
}

/** An op the unit ran: stamp chip, vault, pips, fee, link. */
function OpRow({ s, vault }: { s: Siege; vault: string }) {
  const tone =
    s.status === "held" ? "text-stamp-hold" : s.status === "banished" ? "text-stamp-lockdown" : s.status === "broken" ? "text-stamp-breach" : "text-ink-dim";
  const moves = s.messages.filter((m) => m.role === "guardian").map((m) => m.move);
  const live = s.status === "in_progress" || s.status === "created";
  return (
    <li>
      <Link
        href={`/siege/${s.id}`}
        className="flex items-center gap-3 px-3 py-2 transition-colors hover:bg-ink/[0.04] focus-visible:bg-ink/[0.06] focus-visible:outline-none"
      >
        <span className="w-[92px] shrink-0">
          {live ? (
            <LED kind="live" label="OP LIVE" />
          ) : (
            <span className={cn("inline-block -rotate-3 border-2 border-current px-1.5 py-0.5 font-ui text-[11px] leading-none tracking-[0.08em]", tone)}>{statusLabel(s.status)}</span>
          )}
        </span>
        <span className="min-w-0 flex-1 truncate font-ui text-xs text-ink uppercase">{vault}</span>
        <Pips used={s.turn} status={s.status} moves={moves} pending={live} showLabel={false} className="hidden sm:flex" />
        {s.receipt && !s.receipt.free ? <Amount amount={s.receipt.amount} size="xs" animate={false} /> : <span className="font-ui text-[10px] text-ink-dim">RECON</span>}
        <span aria-hidden className="font-ui text-[10px] text-ink-dim">
          ▸
        </span>
      </Link>
    </li>
  );
}

/** `NEW UNIT ▶`: scrolls to the create form on the agents page. */
function NewUnitLink() {
  return (
    <a
      href="#new-unit"
      className="font-ui text-xs tracking-[0.1em] text-accent uppercase underline-offset-4 hover:underline"
      onClick={(e) => {
        const el = document.getElementById("new-unit");
        if (!el) return;
        e.preventDefault();
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      }}
    >
      {UNITS.newUnitLink}
    </a>
  );
}

/**
 * An operator account's slim panel (typed ops only, no 0G brain): BALANCE as the hero, WITHDRAW, and
 * the line that a unit with 0G connected is what runs on its own. No budget, targeting, ops or DEPLOY:
 * it spends what it holds, on the ops its operator types on a vault page.
 */
function ManualAccount({ detail, idle, refresh, canDrive }: { detail: AgentDetail; idle: boolean; refresh: () => void; canDrive: boolean }) {
  const a = detail.agent;
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0 space-y-1 text-sm text-ink-dim">
          <p>
            <span className="font-ui text-xs text-money uppercase">{UNITS.accountTag}</span>
          </p>
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
            own account <HashscanLink accountId={a.accountId} />
          </p>
        </div>
        <div className="text-right" data-testid="account-balance-hero">
          <p className="font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">{UNITS.accountBalanceHero}</p>
          <Amount amount={detail.balance ?? "0"} size="xl" />
        </div>
      </div>
      <UnitFunds detail={detail} idle={idle} refresh={refresh} hideBalance />
      <p className="text-sm text-ink-dim">{UNITS.accountPanelHint}</p>
      {canDrive ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-dim" data-testid="needs-0g">
          <span className="min-w-0 flex-1">
            <span className="font-ui text-xs text-warn uppercase">{UNITS.needs0g}</span> · {UNITS.needs0gBody}
          </span>
          <NewUnitLink />
        </p>
      ) : (
        <p className="text-sm text-ink-dim">{UNITS.notYourUnitBody}</p>
      )}
    </>
  );
}

const field =
  "min-h-11 w-full border-2 border-line bg-bg px-2.5 font-term text-[20px] leading-none text-ink focus:border-accent focus:outline-none disabled:opacity-60";

/**
 * Mission panel: unit header with budget left, targeting (Arkiv-backed list of guarding vaults),
 * `DEPLOY ▶` / `STOP ■`, the COMMS radio while a cap hit waits for the owner, the resolution line
 * once decided, the mission log and the unit's ops with stamps. Key it by agent id: a different
 * unit is a different radio (cue history resets).
 *
 * @example <MissionPanel detail={detail} castles={castles} refresh={refresh} />
 */
export function MissionPanel({
  detail,
  castles,
  vaultNames,
  underSiege,
  targeting,
  onRadio,
  refresh,
}: Omit<AgentPanelProps, "agentId"> & { detail: AgentDetail; refresh: () => void }) {
  const { agent: a, approvals, events, sieges } = detail;
  // Only this unit's operator (its rk_ key) or the arena owner may drive it; the server says which.
  const canDrive = Boolean(detail.access);
  // An operator account (no 0G key) pays the ops its operator types; it never runs on its own.
  const manual = isManualUnit(a);
  const status = liveStatus(a, approvals);
  const pending = approvals.find((x) => x.status === "pending");
  // Only guarding vaults take ops.
  const openCastles = castles.filter((c) => vaultStateOf(c) === "guarding");
  const [target, setTarget] = useState("");
  // 5 ops: after an APPROVE the unit visibly resumes instead of going IDLE straight away
  const [maxSieges, setMaxSieges] = useState("5");
  const [busy, setBusy] = useState<"run" | "stop" | null>(null);
  const castleId = (openCastles.some((c) => c.id === target) ? target : "") || openCastles[0]?.id || "";
  const names = useMemo(() => new Map([...castles, ...(vaultNames ?? [])].map((c) => [c.id, c.name])), [castles, vaultNames]);
  const vaultName = (id: string | undefined) => (id ? names.get(id) : undefined) ?? "a vault";
  const resolution = useComms(approvals, onRadio);
  const g = unitGauges(a, sieges, approvals, castleId);
  // Clamped: a withdrawn stub unit's budget sits below spent (its payouts were withdrawn too).
  const rawLeft = toUnits(a.budget) - toUnits(a.spent);
  const left = rawLeft > BigInt(0) ? rawLeft : BigInt(0);
  const active = status === "running" || status === "waiting";
  const owner = useOwnerGate(UNITS.ownerGateReason);
  // A cap hit radios in: bring COMMS (amount asked + the live wait clock) on screen, it is the beat.
  const commsRef = useRef<HTMLDivElement>(null);
  const pendingId = pending?.id;
  useEffect(() => {
    if (!pendingId) return;
    const id = requestAnimationFrame(() => commsRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    return () => cancelAnimationFrame(id);
  }, [pendingId]);

  async function run() {
    if (!castleId) return;
    setBusy("run");
    try {
      const n = Number.parseInt(maxSieges, 10);
      await owner.gate(() => api.runAgent(a.id, { castleId, ...(Number.isFinite(n) && n > 0 ? { maxSieges: n } : {}) }));
      toast.success(`${a.name.toUpperCase()} DEPLOYED`, { description: `Running ops on ${names.get(castleId) ?? "the vault"}.` });
      refresh();
    } catch (e) {
      toast.error("Couldn't deploy the unit", { description: describeError(e) });
    } finally {
      setBusy(null);
    }
  }
  async function stop() {
    setBusy("stop");
    try {
      await owner.gate(() => api.stopAgent(a.id));
      toast(`${a.name.toUpperCase()} STOPPED`);
      refresh();
    } catch (e) {
      toast.error("Couldn't stop the unit", { description: describeError(e) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <PixelPanel
        tone={status === "waiting" ? "warn" : status === "running" ? "threat" : "accent"}
        title={`Mission · ${a.name}`}
        action={<AgentStatusPill status={status} stoppedLabel={manual ? UNITS.withdrawn : undefined} />}
        bodyClassName="space-y-4 p-4"
      >
        {manual ? (
          <ManualAccount detail={detail} idle={!active} refresh={refresh} canDrive={canDrive} />
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="min-w-0 space-y-1 text-sm text-ink-dim">
                <p>
                  strategy <span className="font-ui text-xs text-ink uppercase">{a.strategy}</span>
                </p>
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  own account <HashscanLink accountId={a.accountId} />
                </p>
              </div>
              <div className="text-right">
                <p className="font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">Budget left</p>
                <Amount amount={left.toString()} size="xl" />
              </div>
            </div>

            <UnitFunds detail={detail} idle={!active} refresh={refresh} />

            <div className="min-w-0 space-y-2 border-2 border-dashed border-line p-3 [&_[role=group]>div]:flex-wrap">
              <p className="font-ui text-[11px] tracking-[0.12em] text-ink-dim uppercase">Targeting</p>
              {targeting}
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="min-w-0 flex-1">
                <span className="mb-1 block font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">Target vault</span>
                <select value={castleId} onChange={(e) => setTarget(e.target.value)} disabled={openCastles.length === 0 || active} className={field}>
                  {openCastles.length === 0 ? <option value="">{EMPTY.noVaultTaking.title}</option> : null}
                  {openCastles.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name.toUpperCase()} · {tierLabel(c.tier, c.transport)}
                      {underSiege?.has(c.id) ? " · OP LIVE NOW" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className="sm:w-24">
                <span className="mb-1 block font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">Ops</span>
                <input value={maxSieges} onChange={(e) => setMaxSieges(e.target.value)} inputMode="numeric" disabled={active} className={cn(field, "tabular")} />
              </label>
              {!canDrive ? (
                <PixelButton variant="outline" size="lg" className="sm:min-w-36" disabled data-testid="not-your-unit">
                  {UNITS.notYourUnit}
                </PixelButton>
              ) : active ? (
                <PixelButton variant="threatOutline" size="lg" className="sm:min-w-36" onClick={() => void stop()} disabled={busy !== null}>
                  {busy === "stop" ? <Loader2 className="animate-spin" /> : null}
                  {BUTTONS.stop}
                </PixelButton>
              ) : (
                <PixelButton variant="threat" size="lg" cue="deploy" className="sm:min-w-36" onClick={() => void run()} disabled={busy !== null || !castleId}>
                  {busy === "run" ? <Loader2 className="animate-spin" /> : null}
                  {BUTTONS.deploy}
                </PixelButton>
              )}
            </div>
            {!canDrive ? (
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink-dim">
                <span className="min-w-0 flex-1">{UNITS.notYourUnitBody}</span>
                <NewUnitLink />
              </p>
            ) : openCastles.length === 0 ? (
              <p className="text-sm text-ink-dim">
                <span className="font-ui text-xs text-warn uppercase">{EMPTY.noVaultTaking.title}</span> · {EMPTY.noVaultTaking.body}
              </p>
            ) : (
              <p className="text-xs text-ink-dim">Each op pays the vault fee from the unit&apos;s own account. A cap hit pauses the unit and radios the owner.</p>
            )}
          </>
        )}
      </PixelPanel>

      <p role="status" aria-live="polite" className="sr-only">
        {pending ? `${a.name} hit a cap and is waiting for the owner.` : ""}
      </p>
      {pending ? (
        <div ref={commsRef} className="scroll-my-4">
          <WaitingForOwner approval={pending} ops={g.vaultId === pending.castleId ? g.vaultOps : undefined} />
        </div>
      ) : null}
      {owner.dialog}
      {!pending && resolution ? <ResolutionLine r={resolution} running={status === "running"} /> : null}

      <PixelPanel title="Mission log" bodyClassName="p-0">
        <MissionLog events={events} vaultName={vaultName} empty={manual ? UNITS.accountLogEmpty : "no traffic yet · pick a vault and DEPLOY ▶"} className="border-0" />
      </PixelPanel>

      {sieges.length ? (
        <PixelPanel title="Ops" action={<span className="font-ui text-[10px] text-ink-dim">{sieges.length} RECENT</span>} bodyClassName="p-0">
          <ul className="divide-y-2 divide-line/60">
            {sieges.slice(0, 10).map((s) => (
              <OpRow key={s.id} s={s} vault={names.get(s.castleId) ?? s.castleId} />
            ))}
          </ul>
        </PixelPanel>
      ) : null}
    </div>
  );
}
