"use client";

import { visitorId } from "@/lib/hooks/useVisitor";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import type { Castle, Siege, SiegeStatus } from "@/lib/types";
import { HOSTED_PROTECTED_TOOL } from "@/lib/types";
import { ApiError, api, describeError, isNotGuarding, type CastleDetail, type CloseCastleResponse } from "@/lib/api/client";
import { usePolling, useNow } from "@/lib/hooks/usePolling";
import { useConfig } from "@/lib/hooks/useConfig";
import { formatAmount, shortAccount, timeAgo, toUnits } from "@/lib/money/format";
import { isTerminal, vaultStateOf } from "@/lib/money/vault";
import { BUTTONS, EMPTY, LED as LED_TEXT, MONEY, PUBLISH, TOASTS, UNITS, guardRank, guardRankLevel, statusLabel } from "@/lib/vocab";
import { UnitPicker, useMyUnits } from "@/components/raider/unit-picker";
import { rememberHandOp } from "@/lib/agents/hand-ops";
import { useOwnerDevice } from "@/lib/publish/store";
import { PlugInAgent } from "@/components/owner/plug-in-agent";
import { useOrigin } from "@/components/publish/live-card";
import { Amount } from "@/components/money/amount";
import { HashscanLink } from "@/components/money/hashscan-link";
import { ZgCredits } from "@/components/money/zg-credits";
import { Dialog } from "@/components/pixel/dialog";
import { Digits } from "@/components/pixel/digits";
import { LED } from "@/components/pixel/led";
import { PixelButton, pixelButtonVariants } from "@/components/pixel/button";
import { PixelPanel } from "@/components/pixel/panel";
import { Pips } from "@/components/pixel/pips";
import { Stamp, type StampKind } from "@/components/pixel/stamp";
import { playCue } from "@/components/pixel/sfx-link";
import { EmptyState, ErrorState, Loading } from "@/components/ui/state";
import { TIER_DEFENSES, TierPips } from "@/components/arena/tier";
import { ProtectedTool, TransportBadge, VaultSetupSteps, setupProgress, vaultStateLed } from "@/components/arena/vault-state";
import { ArkivCard } from "@/components/arena/arkiv-card";
import { RankChevrons } from "@/components/grid/guard-post";
import { MonitorPortrait } from "@/components/grid/monitor";
import { PotDigits } from "@/components/grid/vault-card";
import { isReconUsed } from "@/components/grid/recon-briefing";
import { cn } from "@/lib/utils";
import { clearFork, useFork } from "@/lib/hooks/useFork";

/** Fallback until /api/config arrives (the contract default). */
const DEFAULT_SPLIT_BPS = { castellan: 8000, pot: 1500, arena: 500 };

/** Personality preset → the voice tag on the dossier. */
const VOICE: Record<string, string> = {
  bumbling: "CHEERFUL",
  stern: "TERSE",
  bureaucratic: "FORMAL",
  mocking: "DRY",
  paranoid: "PARANOID",
};

export function CastleView() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, refresh } = usePolling(() => api.castle(id), 3000, { key: id });

  if (error && !data) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
        {notFound ? (
          <EmptyState title="NO SUCH VAULT" hint="It may have been closed, or the database was reset.">
            <Link href="/" className={cn(pixelButtonVariants({ size: "sm" }), "mt-2")}>
              ◀ THE GRID
            </Link>
          </EmptyState>
        ) : (
          <ErrorState error={error} onRetry={() => void refresh()} title="API OFFLINE" />
        )}
      </div>
    );
  }
  if (loading || !data) return <Loading label="Approaching the vault…" />;
  return <Briefing detail={data} refresh={() => void refresh()} />;
}

// ─── the op start (shared by the console panel and the phone's sticky bar) ────────────────

type Busy = "paid" | "free" | null;
/** Shortest time the x402 lights stay up, so 402 → SIGN → SETTLE reads even on a stub payment. */
const PAY_FLOOR_MS = 1200;
type StartState = {
  busy: Busy;
  step: 0 | 1 | 2 | 3;
  refused: string | null;
  reconUsed: boolean;
  start: (free: boolean) => void;
  /** Onboarding J4: the red teamer's unit that pays this op (its operator key is in the browser); absent = the demo wallet. */
  payFrom?: { id: string; name: string };
  units: ReturnType<typeof useMyUnits>;
};

/**
 * `api.playStart` with the x402 three-light sequence (402 → SIGN → SETTLE). The server does the
 * whole round trip in one call, so the lights pace themselves and the last one holds until it
 * lands. Sounds: `coin_pay` on settle, `recon_start` for a free op.
 */
function useOpStart(c: Castle, onRefused: () => void): StartState {
  const router = useRouter();
  const units = useMyUnits();
  const payFrom = units.unit ? { id: units.unit.id, name: units.unit.name } : undefined;
  const [busy, setBusy] = useState<Busy>(null);
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [refused, setRefused] = useState<string | null>(null);
  const [reconUsed, setReconUsed] = useState(false);
  // Is this page on screen? Activity keeps it mounted while hidden: a start that lands after the
  // operator walked away must not pull them back into the Op room.
  const shown = useRef(true);

  // Pages stay mounted (hidden) after navigation: reset transient state when this one is hidden.
  useLayoutEffect(() => {
    shown.current = true;
    return () => {
      shown.current = false;
    };
  }, []);
  useLayoutEffect(
    () => () => {
      setBusy(null);
      setStep(0);
    },
    [],
  );

  useEffect(() => {
    if (busy !== "paid") return;
    const a = setTimeout(() => setStep((s) => (s < 2 ? 2 : s)), 450);
    const b = setTimeout(() => setStep((s) => (s < 3 ? 3 : s)), 1000);
    return () => {
      clearTimeout(a);
      clearTimeout(b);
    };
  }, [busy]);

  async function start(free: boolean) {
    setBusy(free ? "free" : "paid");
    setStep(free ? 0 : 1);
    setRefused(null);
    const t0 = Date.now();
    try {
      const res = free
        ? await api.playRecon({ castleId: c.id, visitor: visitorId() })
        : payFrom
          ? await api.playStartFromUnit({ castleId: c.id, agentId: payFrom.id })
          : await api.playStart({ castleId: c.id });
      // Stub payments land in a blink: hold the three lights long enough to read (≈1.2 s total).
      if (!free) await new Promise((r) => setTimeout(r, Math.max(0, PAY_FLOOR_MS - (Date.now() - t0))));
      if (!free && payFrom) rememberHandOp(res.siegeId);
      const opHref = `/siege/${res.siegeId}?go=1`;
      if (!shown.current) {
        // they left mid-payment: the op is theirs, but say so instead of yanking them back
        toast.success(free ? TOASTS.reconStarted.title : TOASTS.paid(formatAmount(c.fee, c.asset)).title, {
          description: `Your op on ${c.name} is open.`,
          action: { label: "WATCH ▶", onClick: () => router.push(opHref) },
        });
        return;
      }
      if (free) {
        playCue("recon_start");
        toast.success(TOASTS.reconStarted.title, { description: TOASTS.reconStarted.body });
      } else {
        setStep(3);
        playCue("coin_pay");
        const t = TOASTS.paid(formatAmount(c.fee, c.asset));
        const url = res.receipt && "hashscanUrl" in res.receipt ? res.receipt.hashscanUrl : undefined;
        toast.success(t.title, {
          description: t.body,
          action: url ? { label: "receipt ↗", onClick: () => window.open(url, "_blank", "noopener,noreferrer") } : undefined,
        });
      }
      router.push(opHref);
    } catch (e) {
      setBusy(null);
      setStep(0);
      if (isReconUsed(e)) {
        setReconUsed(true);
        playCue("deny");
        toast.error(TOASTS.reconUsed.title, { description: TOASTS.reconUsed.body });
      } else if (isNotGuarding(e)) {
        toast.error("NOT TAKING OPS", { description: describeError(e) });
        onRefused();
      } else if (e instanceof ApiError && (e.status === 402 || e.code === "spend_control" || e.code === "payment_failed")) {
        const why = describeError(e);
        setRefused(why);
        playCue("deny");
        toast.error(TOASTS.paymentRefused(why).title, { description: why });
      } else if (e instanceof ApiError && e.code === "cap_reached") {
        const why = String((e.body as { reason?: unknown } | null)?.reason ?? "spend").replace("_", "-");
        playCue("deny");
        toast.error(UNITS.capReached(why));
      } else if (e instanceof ApiError && (e.code === "awaiting_approval" || e.code === "unit_stopped")) {
        playCue("deny");
        toast.error(e.code === "unit_stopped" ? UNITS.unitStopped : UNITS.unitBusy);
      } else if (e instanceof ApiError && e.status === 409) toast.error("NOT TAKING OPS", { description: "This vault isn't open for ops." });
      else toast.error("OP DIDN'T START", { description: describeError(e) });
    }
  }

  return { busy, step, refused, reconUsed, start: (free) => void start(free), payFrom, units };
}

/** Why the RUN OP button is off, in the copy deck's words (null while guarding). */
function disabledReason(c: Castle, sieges: Siege[], now: number): { text: string; href?: string } | null {
  const state = vaultStateOf(c);
  switch (state) {
    case "guarding":
      return null;
    case "dormant":
      return { text: LED_TEXT.offline(c.lastSeenAt && now ? timeAgo(c.lastSeenAt, now).replace(" ago", "") : undefined) };
    case "broken": {
      const b = sieges.find((s) => s.status === "broken" && !s.free);
      return { text: "BREACHED · see the replay", href: b ? `/replay/${b.id}` : undefined };
    }
    case "closed":
      return { text: `CLOSED · ${c.vaultStateReason === "owner_closed" || !c.vaultStateReason ? "owner closed" : c.vaultStateReason.replace(/_/g, " ")}` };
    default: {
      const p = setupProgress(c.transport ?? "hosted", state);
      return { text: p ? LED_TEXT.settingUp(p.k, p.n) : "NOT TAKING OPS" };
    }
  }
}

/** A paid op still running: in progress and not voided by the arena (dormant / closed vault refunds). */
const isLiveOp = (s: Siege) => s.status === "in_progress" && s.settlement?.state !== "void";
const opLabel = (s: Siege) => (s.status === "in_progress" && s.settlement?.state === "void" ? LED_TEXT.opVoid : statusLabel(s.status));

// ─── the page ─────────────────────────────────────────────────────────────────────────────

function Briefing({ detail, refresh }: { detail: CastleDetail; refresh: () => void }) {
  const { castle: c, sieges, audit } = detail;
  const op = useOpStart(c, refresh);
  const now = useNow(15_000);
  const liveOp = sieges.find(isLiveOp);
  const reason = disabledReason(c, sieges, now);
  const ownsThisVault = useOwnerDevice(c.id).owner;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 pt-5 pb-32 sm:px-6 sm:pt-8 lg:pb-12">
      <Link href="/" className="mb-5 inline-flex items-center gap-2 font-ui text-[11px] tracking-[0.12em] text-ink-dim uppercase hover:text-ink">
        <span aria-hidden>◀</span> The Grid
      </Link>

      <ForkNote castleId={c.id} />

      {vaultStateOf(c) !== "guarding" ? <OwnerPlugIn castle={c} className="mb-7" /> : null}

      {/* phone: one column in reading order (display:contents + order); desktop: two columns */}
      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start lg:gap-7">
        <div className="contents lg:flex lg:flex-col lg:gap-5">
          <Identity castle={c} live={Boolean(liveOp)} now={now} className="order-1" />
          <div className="order-6">
            <ArkivCard castleId={c.id} />
          </div>
          {/* On the owner's own device the panel (credits dropping, fee cut earned) comes right after the identity. */}
          <OwnerPanel castle={c} onClosed={refresh} className={ownsThisVault ? "order-2" : "order-7"} />
        </div>
        <div className="contents lg:flex lg:flex-col lg:gap-5">
          <Dossier castle={c} sieges={sieges} className="order-2" />
          <OpConsole castle={c} op={op} reason={reason} liveOp={reason ? undefined : liveOp} className="order-3" />
          <RecentOps castle={c} sieges={sieges} now={now} className="order-4" />
          <AuditTrail audit={audit} now={now} className="order-5" />
        </div>
      </div>

      {vaultStateOf(c) === "guarding" ? <OwnerPlugIn castle={c} className="mt-7" /> : null}

      <StickyRunBar castle={c} op={op} reason={reason} />
    </div>
  );
}

/**
 * SDK vaults, on the owner's device: the plug-in panel (install snippet, the six-LED strip, fund) on
 * the vault page too, so an owner who left /publish, or the seeded Refund Desk's owner, can follow
 * connect -> self-check -> smoke op -> verified -> fund -> guarding and rotate the guard key.
 */
function OwnerPlugIn({ castle: c, className }: { castle: Castle; className?: string }) {
  const { owner } = useOwnerDevice(c.id);
  const origin = useOrigin();
  if (c.transport !== "sdk" || !owner || isTerminal(vaultStateOf(c))) return null;
  return (
    <section className={className} data-testid="owner-plug-in">
      <PlugInAgent castleId={c.id} baseURL={origin} />
    </section>
  );
}

// ─── fork: a replay's operator lines queued for the next op here ──────────────────────────

/** FORK INTO A NEW OP (replay) lands here: say where the script came from; DEMO LINE ✎ in the Op room plays it. */
function ForkNote({ castleId }: { castleId: string }) {
  const fork = useFork(castleId);
  if (!fork) return null;
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 bg-panel px-4 py-3 px-frame [--frame:color-mix(in_oklab,var(--color-money)_55%,var(--color-line))]" role="status">
      <p className="font-term text-lg leading-tight text-ink">
        <span className="font-ui text-[11px] tracking-[0.12em] text-money uppercase">Forked from </span>
        <Link href={`/replay/${fork.from}`} className="text-money underline-offset-4 hover:underline">
          OP #{fork.from.slice(-4)}
        </Link>
        <span className="text-ink-dim"> · {fork.lines.length} line{fork.lines.length === 1 ? "" : "s"} queued on {BUTTONS.demoLine} in the Op room</span>
      </p>
      <PixelButton size="sm" variant="ghost" onClick={clearFork}>
        Clear
      </PixelButton>
    </div>
  );
}

// ─── identity: portrait, name, rank, tier, voice, protects, defenses ─────────────────────

function Identity({ castle: c, live, now, className }: { castle: Castle; live: boolean; now: number; className?: string }) {
  const state = vaultStateOf(c);
  const transport = c.transport ?? "hosted";
  const rank = guardRank(c.title || c.streak);
  const led = vaultStateLed(state, transport);
  const tool = c.protectedTool || HOSTED_PROTECTED_TOOL;
  const voice = VOICE[(c.personality ?? "").toLowerCase()] ?? "TERSE";
  return (
    <section aria-labelledby="vault-name" className={cn("flex min-w-0 items-start gap-4 lg:flex-col", className)}>
      <MonitorPortrait
        castle={c}
        live={live && state === "guarding"}
        bare
        status={live && state === "guarding" ? <LED kind="live" label="LIVE OP" /> : <LED kind={led.kind} label={led.label} blink={led.blink} />}
      />
      <div className="min-w-0 flex-1 space-y-2.5">
        <h1 id="vault-name" className="text-xl leading-tight text-ink glow sm:text-3xl">
          {c.name}
        </h1>
        <p className="text-[15px] text-ink">
          <span className="text-ink-dim">Guard</span> {c.guardianName}
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <RankChevrons rank={rank} level={guardRankLevel(rank)} scale={2} />
          <TierPips tier={c.tier} transport={transport} />
          <span className="border-2 border-line px-1.5 py-0.5 font-ui text-[10px] tracking-[0.14em] text-ink-dim" title="How the guard talks">
            {voice}
          </span>
        </div>
        {c.published && c.blurb ? <p className="max-w-md text-[15px] leading-relaxed text-ink">{c.blurb}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <ProtectedTool tool={tool} />
          {transport === "sdk" ? <TransportBadge transport={transport} /> : null}
          {c.published ? (
            <span className="border-2 border-money/50 px-1.5 py-0.5 font-ui text-[10px] tracking-[0.14em] text-money">{PUBLISH.publishedTag}</span>
          ) : null}
        </div>
        {c.published && (c.toolNames?.length ?? 0) > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Tools">
            {c.toolNames!.map((n) => (
              <li
                key={n}
                className={cn(
                  "border-2 px-1.5 py-0.5 font-mono text-[11px]",
                  n === tool ? "border-threat/60 text-threat" : "border-line text-ink-dim",
                )}
                title={n === tool ? "A call to this tool counts as a breach" : undefined}
              >
                {n}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="max-w-md text-sm leading-relaxed text-ink-dim max-sm:hidden">{TIER_DEFENSES[c.tier]}</p>
        <StateLine castle={c} now={now} />
      </div>
    </section>
  );
}

/** One line under the identity: SDK heartbeat while guarding, or why the vault is resting. */
function StateLine({ castle: c, now }: { castle: Castle; now: number }) {
  const state = vaultStateOf(c);
  const transport = c.transport ?? "hosted";
  if (state === "guarding") {
    return transport === "sdk" ? (
      <p className="font-term text-lg leading-tight text-ink-dim">
        <LED kind="safe" label={false} className="mr-2" />
        SDK · {c.protectedTool} · heartbeat {c.lastSeenAt && now ? timeAgo(c.lastSeenAt, now) : "—"}
      </p>
    ) : null;
  }
  const text =
    state === "dormant"
      ? `Missed three heartbeats${c.lastSeenAt && now ? ` · last seen ${timeAgo(c.lastSeenAt, now)}` : ""}. Live paid ops were refunded; the pot stays in the vault.`
      : state === "closed"
        ? "Closed. The pot went back to the owner."
        : state === "broken"
          ? "An operator talked the guard into it and the vault paid out."
          : "Still being set up. Not taking ops yet.";
  return (
    <div className="space-y-1.5 border-l-2 border-line pl-3 text-sm text-ink-dim">
      {state === "created" || state === "connected" || state === "verified" || state === "funded" ? <VaultSetupSteps transport={transport} state={state} /> : null}
      <p>{text}</p>
    </div>
  );
}

// ─── dossier: the numbers and the money line ─────────────────────────────────────────────

function Dossier({ castle: c, sieges, className }: { castle: Castle; sieges: Siege[]; className?: string }) {
  const { config } = useConfig();
  const split = config?.feeSplitBps ?? DEFAULT_SPLIT_BPS;
  const now = useNow(30_000);
  const last = sieges[0];
  const fee = toUnits(c.fee);
  const part = (bps: number) => formatAmount((fee * BigInt(bps)) / BigInt(10_000), c.asset, { symbol: false });
  const lanes = [
    { k: "OWNER", bps: split.castellan, cls: "bg-safe" },
    { k: "POT", bps: split.pot, cls: "bg-money" },
    { k: "ARENA", bps: split.arena, cls: "bg-ink-dim" },
  ];
  return (
    <PixelPanel title="Dossier" tone="money" className={className} bodyClassName="space-y-4 p-4">
      <div>
        <p className="font-ui text-[10px] tracking-[0.16em] text-ink-dim uppercase">Pot</p>
        <PotDigits castle={c} size="2xl" className="mt-2" />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-y-2 border-line py-3 sm:grid-cols-4">
        <Stat k="Fee">
          <Digits value={formatAmount(c.fee, c.asset, { symbol: false })} unit="ℏ" tone="money" size="sm" />
        </Stat>
        <Stat k="Streak">
          <Digits value={c.streak} size="sm" tone={c.streak >= 10 ? "warn" : "ink"} />
        </Stat>
        <Stat k="Ops">
          <Digits value={c.siegeCount} size="sm" />
        </Stat>
        <Stat k="Last op">
          {last ? (
            <span className="font-term text-lg leading-none text-ink">
              {timeAgo(last.endedAt ?? last.createdAt, now)} <span className="text-ink-dim">· {opLabel(last)}</span>
            </span>
          ) : (
            <span className="font-term text-lg leading-none text-ink-dim">none yet</span>
          )}
        </Stat>
      </dl>
      <div className="space-y-2">
        <div className="flex h-3 gap-[2px]" aria-hidden>
          {lanes.map((l) => (
            <span key={l.k} className={cn("h-full", l.cls)} style={{ flexGrow: l.bps }} title={`${l.k} ${(l.bps / 100).toFixed(0)}%`} />
          ))}
        </div>
        <p className="text-sm leading-relaxed text-ink-dim">
          {MONEY.ifHolds(part(split.castellan), part(split.pot), part(split.arena)).replace(" · a breach pays pot + fee", "")}
          <span className="text-ink"> · a breach pays pot + fee</span>
        </p>
      </div>
    </PixelPanel>
  );
}

function Stat({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">{k}</dt>
      <dd className="mt-1.5 truncate">{children}</dd>
    </div>
  );
}

// ─── the console: RUN OP / RECON ─────────────────────────────────────────────────────────

/** `PAYING… 402 → SIGN → SETTLE` with three lights lit in sequence. */
function PayingLights({ step }: { step: number }) {
  const parts = ["402", "SIGN", "SETTLE"];
  return (
    <span className="inline-flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
      <span>PAYING…</span>
      {parts.map((p, i) => (
        <span key={p} className="inline-flex items-center gap-1.5">
          {i > 0 ? <span aria-hidden className="opacity-60">→</span> : null}
          <span
            aria-hidden
            className={cn(
              "size-2.5",
              step > i ? "bg-bg" : "bg-transparent shadow-[inset_0_0_0_2px_rgb(0_0_0/0.5)]",
              step === i + 1 && i === 2 && "animate-blink",
            )}
          />
          <span className={cn(step > i ? "opacity-100" : "opacity-45")}>{p}</span>
        </span>
      ))}
      <span className="sr-only">
        {step >= 3 ? "Settling the payment" : step === 2 ? "Signing the payment" : "Asking for the price (402)"}
      </span>
    </span>
  );
}

function RunOpButton({ castle: c, op, reason, className }: { castle: Castle; op: StartState; reason: { text: string; href?: string } | null; className?: string }) {
  const fee = formatAmount(c.fee, c.asset);
  // A breached vault: the primary action is the replay of the breach, not a dead button.
  if (reason?.href) {
    return (
      <Link href={reason.href} className={cn(pixelButtonVariants({ variant: "money", size: "xl" }), "w-full max-sm:text-[13px]", className)}>
        REPLAY THE BREACH ▶
      </Link>
    );
  }
  return (
    <PixelButton
      variant="money"
      size="xl"
      cue={null}
      className={cn("w-full max-sm:text-[13px]", className)}
      disabled={Boolean(reason) || op.busy !== null}
      aria-live="polite"
      onClick={() => op.start(false)}
    >
      {op.busy === "paid" ? <PayingLights step={op.step} /> : reason ? reason.text.toUpperCase() : op.payFrom ? `RUN OP — ${UNITS.payFrom(op.payFrom.name)} (${fee})` : BUTTONS.runOp(fee)}
    </PixelButton>
  );
}

function OpConsole({ castle: c, op, reason, liveOp, className }: { castle: Castle; op: StartState; reason: { text: string; href?: string } | null; liveOp?: Siege; className?: string }) {
  const { config } = useConfig();
  return (
    <PixelPanel
      title="Run an op"
      tone={reason ? "default" : "accent"}
      action={liveOp ? <LED kind="live" label="OP LIVE" /> : null}
      className={className}
      bodyClassName="flex flex-col gap-3 p-4"
    >
      <UnitPicker units={op.units.units} selected={op.units.selected} onSelect={op.units.setSelected} disabled={op.busy !== null} />
      <RunOpButton castle={c} op={op} reason={reason} className="max-lg:hidden" />
      <PixelButton variant="outline" size="lg" cue={null} className="w-full" disabled={Boolean(reason) || op.busy !== null || op.reconUsed} onClick={() => op.start(true)}>
        {op.busy === "free" ? "STARTING RECON…" : op.reconUsed ? "RECON USED TODAY" : BUTTONS.recon}
      </PixelButton>

      {op.refused ? (
        <p role="alert" className="flex items-start gap-2 text-sm text-ink">
          <LED kind="offline" label="PAYMENT REFUSED" className="mt-0.5 shrink-0" />
          <span className="text-ink-dim">{op.refused}</span>
        </p>
      ) : null}
      {reason ? (
        <p className="text-sm text-ink-dim">
          Not taking ops: <span className="text-ink">{reason.href ? reason.text.replace(" · see the replay", ".") : reason.text}</span>
          {reason.href ? (
            <>
              {" "}
              <Link href={reason.href} className="text-money underline decoration-money/40 underline-offset-4 hover:decoration-money">
                REPLAY ▶
              </Link>
            </>
          ) : null}
        </p>
      ) : (
        <p className="text-xs leading-relaxed text-ink-dim">
          Five messages. {op.payFrom ? `${op.payFrom.name} pays from its own account over x402, so a breach pays out to it.` : "The server pays from the arena's demo wallet over x402, so there is no wallet to connect."} Recon is free
          {config ? ` (${config.freeSiegesPerDay} a day)` : ""} and never pays out.
        </p>
      )}
      {liveOp ? (
        <Link href={`/siege/${liveOp.id}`} className="flex items-center justify-between gap-3 border-2 border-threat/40 bg-threat/5 px-3 py-2 hover:bg-threat/10">
          <span className="font-term text-lg leading-tight text-ink">An operator is in there now</span>
          <span className="flex shrink-0 items-center gap-3">
            <Pips used={liveOp.turn} pending showLabel={false} />
            <span className="font-ui text-[10px] tracking-[0.12em] text-threat">WATCH ▶</span>
          </span>
        </Link>
      ) : null}
    </PixelPanel>
  );
}

/** Phone: the primary action stays under the thumb. */
function StickyRunBar({ castle: c, op, reason }: { castle: Castle; op: StartState; reason: { text: string; href?: string } | null }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t-2 border-line bg-bg/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] lg:hidden">
      <RunOpButton castle={c} op={op} reason={reason} />
    </div>
  );
}

// ─── recent ops (log rows with stamps) ───────────────────────────────────────────────────

const STATUS_STAMP: Partial<Record<SiegeStatus, StampKind>> = { held: "hold", broken: "breach", banished: "lockdown" };
/** Ended ops open their replay (with the proof checklist); live ones open the op room. */
const ENDED_SIEGE = new Set<SiegeStatus>(["held", "broken", "banished"]);

function RecentOps({ castle: c, sieges, now, className }: { castle: Castle; sieges: Siege[]; now: number; className?: string }) {
  return (
    <PixelPanel title="Recent ops" action={<span className="tabular font-term text-base text-ink-dim">{sieges.length}</span>} className={className}>
      {sieges.length === 0 ? (
        <p className="px-4 py-5 font-ui text-xs tracking-[0.08em] text-ink-dim uppercase">{EMPTY.untried(c.guardianName).title}</p>
      ) : (
        <ul className="max-h-[26rem] divide-y-2 divide-line/60 overflow-y-auto">
          {sieges.map((s) => {
            const kind = STATUS_STAMP[s.status];
            const moves = (s.messages ?? []).filter((m) => m.role === "guardian").map((m) => m.move);
            return (
              <li key={s.id}>
                <Link
                  href={ENDED_SIEGE.has(s.status) ? `/replay/${s.id}` : `/siege/${s.id}`}
                  title={ENDED_SIEGE.has(s.status) ? "Replay and proof" : "Watch live"}
                  className="grid grid-cols-[8.75rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-3 py-2.5 transition-colors hover:bg-raised focus-visible:bg-raised"
                >
                  <span className="flex justify-start">
                    {kind ? (
                      <Stamp kind={kind} size="sm" slam={false} tilt={-3} className="px-1.5 text-[14px]">
                        {statusLabel(s.status)}
                      </Stamp>
                    ) : (
                      <LED kind={isLiveOp(s) ? "live" : "idle"} label={opLabel(s)} />
                    )}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-mono text-xs text-ink/85">{shortAccount(s.raider)}</span>
                    <span className="mt-1 flex items-center gap-2">
                      <Pips used={s.turn} status={s.status} moves={moves} showLabel={false} className="[&_span]:size-2" />
                      {s.agentId ? <span className="font-ui text-[9px] tracking-[0.12em] text-ink-dim">AGENT</span> : null}
                      {s.free ? <span className="font-ui text-[9px] tracking-[0.12em] text-warn">RECON</span> : null}
                    </span>
                  </span>
                  <span className="flex flex-col items-end gap-1 text-right">
                    {s.release ? <Amount amount={s.release.amount} asset={c.asset} size="sm" animate={false} className="font-term text-lg leading-none" /> : null}
                    <span className="tabular font-term text-base leading-none text-ink-dim">{timeAgo(s.endedAt ?? s.createdAt, now)}</span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </PixelPanel>
  );
}

// ─── HCS audit trail ─────────────────────────────────────────────────────────────────────

function AuditTrail({ audit, now, className }: { audit: CastleDetail["audit"]; now: number; className?: string }) {
  return (
    <PixelPanel
      title="HCS audit trail"
      className={className}
      action={audit.topicId ? <HashscanLink topicId={audit.topicId} label={`topic ${audit.topicId}`} className="min-w-0 truncate" /> : null}
    >
      {audit.messages.length === 0 ? (
        <p className="px-4 py-4 font-term text-lg text-ink-dim">
          {audit.topicId ? "> no events written yet · every op event lands here as a hash" : "> no audit topic yet"}
        </p>
      ) : (
        <ol className="max-h-80 overflow-y-auto py-1 font-term text-lg leading-snug">
          {audit.messages.map((m, i) => (
            <li key={`${m.seq ?? "p"}-${i}`} className="flex min-w-0 items-center gap-3 px-4 py-0.5 hover:bg-raised/60">
              <span className="tabular w-10 shrink-0 text-ink-dim" title={m.seq == null ? "Waiting for consensus" : undefined}>
                #{m.seq ?? "…"}
              </span>
              <span className="w-24 shrink-0 truncate text-ink">{m.type}</span>
              <span className="min-w-0 flex-1 truncate text-sm">
                {m.txId ? <HashscanLink txId={m.txId} /> : m.siegeId ? <span className="font-mono text-xs text-ink-dim">{m.siegeId}</span> : null}
              </span>
              <span className="tabular shrink-0 text-base text-ink-dim">{timeAgo(m.at, now)}</span>
            </li>
          ))}
        </ol>
      )}
    </PixelPanel>
  );
}

// ─── owner: close the vault (pixel Dialog, owner key inline) ─────────────────────────────

function OwnerPanel({ castle: c, onClosed, className }: { castle: Castle; onClosed: () => void; className?: string }) {
  const [asking, setAsking] = useState(false);
  const [needKey, setNeedKey] = useState(false);
  const [key, setKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CloseCastleResponse | null>(null);
  const terminal = isTerminal(vaultStateOf(c));
  const { owner: ownerDevice } = useOwnerDevice(c.id);

  // Hidden by Activity: drop the dialog and spinner so coming back never reopens a stale confirm.
  useLayoutEffect(
    () => () => {
      setAsking(false);
      setBusy(false);
    },
    [],
  );

  if (terminal && !result) {
    // Closed or breached: nothing to close, but the owner still sees what the vault earned and burned.
    if (!ownerDevice || !(c.earnings || c.zg?.connected)) return null;
    return (
      <PixelPanel title="Owner" className={className} bodyClassName="flex flex-col gap-3 p-4 text-sm">
        {c.earnings ? (
          <p className="font-term text-[20px] leading-tight text-money" data-testid="owner-earnings">
            {PUBLISH.earned(formatAmount(BigInt(c.earnings.ownerCut), c.asset, { symbol: false }), c.earnings.heldOps)}
          </p>
        ) : null}
        {c.zg?.connected ? <ZgCredits castleId={c.id} variant="hero" /> : null}
      </PixelPanel>
    );
  }

  function dismiss() {
    if (busy) return;
    setAsking(false);
    setNeedKey(false);
    setKey("");
    setKeyError(null);
  }

  async function close() {
    setBusy(true);
    setKeyError(null);
    try {
      if (needKey) {
        try {
          await api.ownerLogin(key.trim());
        } catch (e) {
          setKeyError(e instanceof ApiError && e.status === 401 ? "Wrong key. Only the owner can close this vault." : describeError(e));
          return;
        }
      }
      const res = await api.closeCastle(c.id, "owner_closed");
      setResult(res);
      setAsking(false);
      playCue("stamp_hold");
      toast.success("VAULT CLOSED", { description: `${formatAmount(res.refunded, c.asset)} returned to the owner.` });
      onClosed();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setNeedKey(true);
        setKeyError(needKey ? "That key didn't work." : null);
      } else toast.error("COULDN'T CLOSE THE VAULT", { description: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <PixelPanel title="Owner" className={className} bodyClassName="flex flex-col gap-3 p-4 text-sm">
      {result ? (
        <div role="status" className="space-y-1.5">
          <Stamp kind="lockdown" size="sm" slam>
            VAULT CLOSED
          </Stamp>
          <p className="pt-2 text-ink-dim">
            Pot returned: <Amount amount={result.refunded} asset={c.asset} size="sm" animate={false} />
          </p>
          <p className="text-ink-dim">
            {result.inFlightRefunds === 0 ? "No ops were live." : `${result.inFlightRefunds} live ${result.inFlightRefunds === 1 ? "op" : "ops"} refunded.`}
          </p>
          <HashscanLink tx={result.tx} label="closeVault tx" />
        </div>
      ) : (
        <>
          {ownerDevice && c.earnings ? (
            <p className="font-term text-[20px] leading-tight text-money" data-testid="owner-earnings">
              {PUBLISH.earned(formatAmount(BigInt(c.earnings.ownerCut), c.asset, { symbol: false }), c.earnings.heldOps)}
            </p>
          ) : null}
          {ownerDevice && c.zg?.connected ? <ZgCredits castleId={c.id} variant="hero" /> : null}
          <p className="text-xs leading-relaxed text-ink-dim">Owner only. Closing returns the pot to you on chain and refunds every paid op still live.</p>
          <PixelButton variant="threatOutline" size="md" className="w-full" onClick={() => setAsking(true)}>
            {BUTTONS.closeVault}
          </PixelButton>
        </>
      )}
      <Dialog
        open={asking}
        onClose={dismiss}
        tone="threat"
        title={needKey ? BUTTONS.ownerKey : "CLOSE VAULT?"}
        actions={
          <>
            <PixelButton size="md" onClick={dismiss} disabled={busy}>
              KEEP IT OPEN
            </PixelButton>
            <PixelButton
              variant="threat"
              size="md"
              cue={null}
              disabled={busy || (needKey && !key.trim())}
              onClick={() => void close()}
            >
              {busy ? "CLOSING…" : BUTTONS.closeVault}
            </PixelButton>
          </>
        }
      >
        <div className="space-y-3">
          <p className="leading-relaxed">
            <b className="font-semibold">{c.name}</b>&apos;s pot (<Amount amount={c.pot} asset={c.asset} size="sm" animate={false} />) goes back to the owner and every
            live paid op is refunded. This can&apos;t be undone.
          </p>
          {needKey ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (key.trim()) void close();
              }}
              className="space-y-1.5"
            >
              <label htmlFor="owner-key" className="font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">
                Owner key
              </label>
              <input
                id="owner-key"
                type="password"
                autoComplete="current-password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoFocus
                className="block w-full border-2 border-line bg-bg px-3 py-2 font-mono text-sm text-ink outline-none focus:border-threat"
              />
              {keyError ? (
                <p role="alert" className="text-xs text-threat">
                  {keyError}
                </p>
              ) : (
                <p className="text-xs text-ink-dim">Only the owner can close this vault.</p>
              )}
            </form>
          ) : null}
        </div>
      </Dialog>
    </PixelPanel>
  );
}
