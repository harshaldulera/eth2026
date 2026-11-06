"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import type { Castle, FeeSplit as FeeSplitT, Siege, StoredSiegeEvent } from "@/lib/types";
import { MAX_TURNS } from "@/lib/types";
import { ApiError, api, describeError, type FeeSplitBps, type MessageResponse } from "@/lib/api/client";
import { useConfig } from "@/lib/hooks/useConfig";
import { usePolling } from "@/lib/hooks/usePolling";
import { useSiege, type DemoSiege, type SiegeView } from "@/lib/hooks/useSiege";
import demoSiege from "@/lib/fixtures/demo-siege.json";
import { useCalmMotion } from "@/lib/hooks/usePrefs";
import { useFork } from "@/lib/hooks/useFork";
import { lastOf, parseAttempt } from "@/lib/money/events";
import { formatAmount, toUnits } from "@/lib/money/format";
import { voidCause } from "@/lib/money/vault";
import { MUST_NOT_BREAK, WOODEN_BREAK } from "@/lib/fixtures/raids";
import { toBeats } from "@/lib/scene/beats";
import { opMoney } from "@/lib/scene/money";
import { playCue } from "@/components/pixel/sfx-link";
import { usePlayer } from "@/lib/scene/usePlayer";
import type { SceneFrame } from "@/lib/scene/player";
import { BUTTONS, EMPTY, LED as LED_TEXT, MONEY, OPERATOR_RANKS, TOASTS } from "@/lib/vocab";
import { FeeSplit } from "@/components/money/fee-split";
import { VaultPayout } from "@/components/money/vault-payout";
import { HashscanLink } from "@/components/money/hashscan-link";
import { PaymentReceiptCard } from "@/components/money/payment-receipt-card";
import { PixelButton, pixelButtonVariants } from "@/components/pixel/button";
import { LED } from "@/components/pixel/led";
import { PixelPanel } from "@/components/pixel/panel";
import { FrozenBar, OpScene, OutcomeHeadline, SoundStrip, money, useBeatCues, useTickSounds } from "@/components/scene";
import { EmptyState, ErrorState, Loading } from "@/components/ui/state";
import { cn } from "@/lib/utils";

const ENDED = new Set(["held", "broken", "banished"]);
/** localStorage: set once this browser has landed a paid breach (the RANK UP moment fires once). */
const FIRST_BREACH_KEY = "siege.firstBreach";

/** The send response; `referee` is the additive Part 2 field (threat + tactic of this turn). */
type SendResponse = MessageResponse & { referee?: { pressure: number; tactic: string } };

/**
 * Split for display when the attempt event carried none: the configured bps (/api/config), same
 * integer math as the contract (castellan and arena rounded down, the pot takes the dust).
 */
function splitFor(fee: string, bps: FeeSplitBps = { castellan: 8000, pot: 1500, arena: 500 }): FeeSplitT {
  const f = toUnits(fee);
  const castellan = (f * BigInt(bps.castellan)) / BigInt(10000);
  const arena = (f * BigInt(bps.arena)) / BigInt(10000);
  return { castellan: castellan.toString(), pot: (f - castellan - arena).toString(), arena: arena.toString() };
}

/** A paid op voided under the operator whose refund has not landed (or failed) yet: keep polling. */
const refundPending = (s: Siege) =>
  s.settlement?.state === "void" && !s.free && s.settlement.refund !== undefined && s.settlement.refund.state === "due";

const REASON_TEXT: Record<string, string> = {
  castle_already_broken: "another operator breached this vault moments before you did",
  castle_broken: "another operator breached this vault before your op finished",
  castle_closed: "the vault closed before your op finished",
  vault_expired: "the vault expired before your op finished",
  vault_not_open: "the vault had already been emptied",
  expired: "the vault had expired",
  dormant: "the guard went offline",
  guardian_dormant: "the guard went offline",
  castle_dormant: "the guard went offline",
  orders_changed: "the guard's orders changed and the vault closed",
  owner_closed: "the owner closed the vault",
};
const reasonText = (r?: string) => (r ? (REASON_TEXT[r] ?? r.replace(/_/g, " ")) : "unknown error");

/** How long the room waits for the event backlog before mounting the scene anyway. */
const BACKLOG_WAIT_MS = 2500;

/**
 * True once the feed holds what the siege record says happened: a decision for every guard reply,
 * the end, and the chain events already on the record. The scene then mounts on the newest beat
 * instead of animating the backlog as it streams in.
 */
function backlogIn(siege: Siege, events: StoredSiegeEvent[]): boolean {
  if (!events.length) return false;
  const replies = siege.messages.filter((m) => m.role === "guardian").length;
  const decisions = new Set(events.filter((e) => e.type === "decision" && e.turn).map((e) => e.turn)).size;
  if (decisions < replies) return false;
  if (ENDED.has(siege.status) && !events.some((e) => e.type === "end")) return false;
  if (siege.attempt && !events.some((e) => e.type === "attempt")) return false;
  if (siege.release && !events.some((e) => e.type === "release")) return false;
  return true;
}

export function SiegeRoom() {
  const { id } = useParams<{ id: string }>();
  // ?demo=1 replays a recorded break with no network (UI polish, rehearsals, flaky venue Wi-Fi).
  const demo = useSearchParams().get("demo") === "1" ? (demoSiege as unknown as DemoSiege) : undefined;
  // The record refetches on every event (SSE, polling fallback), and polls slowly for what emits nothing.
  const view = useSiege(id, { demo });
  const siege = view.siege;
  // The demo castle was recorded after the break (pot 0): open on the pot the recorded op found, read
  // off its own payout, so the header holds the real pot until the coins come out.
  const demoPot = useMemo(() => {
    if (!demo) return undefined;
    const last = demo.frames[demo.frames.length - 1];
    return last ? opMoney(last.siege, demo.frames.map((f) => f.event), demo.castle.fee).potBefore : undefined;
  }, [demo]);

  // A paid op voided under the operator: the refund lands with no event on this siege, so poll
  // the record until it is refunded or failed.
  const refundDue = Boolean(siege && view.mode !== "demo" && refundPending(siege));
  const refreshRef = useRef(view.refresh);
  useEffect(() => {
    refreshRef.current = view.refresh;
  });
  useEffect(() => {
    if (!refundDue) return;
    const t = setInterval(() => void refreshRef.current(), 1500);
    return () => clearInterval(t);
  }, [refundDue]);

  // Mount the scene once the feed's backlog is in (or after a short wait): the player then starts
  // on the newest beat instead of replaying the end sequence as the events stream in. The demo
  // mounts at once and plays from the first frame.
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setWaited(true), BACKLOG_WAIT_MS);
    return () => clearTimeout(t);
  }, [id]);
  const [mounted, setMounted] = useState(false);
  if (!mounted && siege && view.castle && (view.mode === "demo" || waited || backlogIn(siege, view.events))) setMounted(true);

  if (view.error && !siege) {
    const notFound = view.error instanceof ApiError && view.error.status === 404;
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-10">
        {notFound ? (
          <EmptyState title={EMPTY.noSuchOp.title} hint={EMPTY.noSuchOp.body}>
            <Link href="/" className={pixelButtonVariants({ variant: "outline", size: "md" })}>
              Back to the Grid
            </Link>
          </EmptyState>
        ) : (
          <ErrorState error={view.error} onRetry={() => void view.refresh()} title="Couldn't load the op" />
        )}
      </div>
    );
  }
  if (!siege || !view.castle || !mounted) return <Loading label="Tuning the vault cam…" />;

  return (
    <Room
      siege={siege}
      castle={view.castle}
      events={view.events}
      mode={view.mode}
      openingPot={demoPot}
      onSiege={view.setSiege}
      refresh={() => void view.refresh()}
    />
  );
}

type LocalTurn = { referee?: SendResponse["referee"]; decision: MessageResponse["decision"]; text: string };

function Room({
  siege,
  castle,
  events,
  mode,
  openingPot,
  onSiege,
  refresh,
}: {
  siege: Siege;
  castle: Castle;
  events: StoredSiegeEvent[];
  /** Streaming (SSE), polling (the stream failed), or replaying the recorded demo (?demo=1). */
  mode: SiegeView["mode"];
  /** The pot the op found, when the castle record is newer than the op (the recorded demo). */
  openingPot?: string;
  onSiege: (s: Siege) => void;
  refresh: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<{ text: string; turn: number } | null>(null);
  const [localExposed, setLocalExposed] = useState<Record<number, string>>({});
  const [freshId, setFreshId] = useState<string | null>(null);
  const [localTurns, setLocalTurns] = useState<Record<number, LocalTurn>>({});
  const [failed, setFailed] = useState<{ text: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const calm = useCalmMotion();
  const fork = useFork(castle.id);
  const demo = mode === "demo";

  const ended = ENDED.has(siege.status) || siege.settlement?.state === "void";
  const voided = siege.settlement?.state === "void";
  const agentDriven = Boolean(siege.agentId);
  // The pot as the op found it: from the op's own settle event when there is one, else the vault as
  // it was when this room opened. The header never jumps ahead of the fee rail / payout.
  const [potAtOpen] = useState(openingPot ?? castle.pot);
  const opCash = useMemo(() => opMoney(siege, events, castle.fee), [siege, events, castle.fee]);
  const potBefore = opCash.potBefore ?? potAtOpen;
  // Was the op still running when this room opened? (one-shot moments only fire then)
  const [openedLive] = useState(!ended);

  // ── scene input: the siege plus the turn in flight, and the send response's referee/decision
  //    as synthetic events until the feed delivers the real ones (real events come later in the
  //    array, so they win in toBeats).
  const showPending = sending && !siege.messages.some((m) => m.role === "raider" && m.turn === sending.turn);
  const sceneSiege = useMemo<Siege>(
    () =>
      showPending && sending
        ? { ...siege, messages: [...siege.messages, { role: "raider", text: sending.text, turn: sending.turn, at: new Date(0).toISOString() }] }
        : siege,
    [siege, showPending, sending],
  );
  const sceneEvents = useMemo<StoredSiegeEvent[]>(() => {
    const synthetic: StoredSiegeEvent[] = [];
    for (const [k, lt] of Object.entries(localTurns)) {
      const turn = Number(k);
      const base = { siegeId: siege.id, castleId: castle.id, turn, at: new Date(0).toISOString(), requestId: lt.decision.requestId };
      if (lt.referee && !events.some((e) => e.type === "message" && e.turn === turn)) {
        synthetic.push({ ...base, id: -turn * 2 - 1, type: "message", payload: { role: "raider", text: lt.text, pressure: lt.referee.pressure, tactic: lt.referee.tactic } });
      }
      if (!events.some((e) => e.type === "decision" && e.turn === turn)) {
        const d = lt.decision;
        synthetic.push({
          ...base,
          id: -turn * 2,
          type: "decision",
          payload: { move: d.move, reply: d.reply, requestId: d.requestId, exposed: d.exposed ?? localExposed[turn] ?? null, toolCalls: d.toolCalls ?? [] },
        });
      }
    }
    return synthetic.length ? [...synthetic, ...events] : events;
  }, [localTurns, events, siege.id, castle.id, localExposed]);

  const beats = useMemo(() => toBeats(sceneSiege, sceneEvents, castle, { mode: "live", reducedMotion: calm }), [sceneSiege, sceneEvents, castle, calm]);
  const onBeatStart = useBeatCues(beats);
  const { frame, waiting } = usePlayer(beats, "live", { onBeatStart });
  useTickSounds(frame);

  // The composer keeps focus through a turn (read-only, never disabled) and sends again once the
  // scene has caught up with the stamp.
  const canSend = !demo && !ended && !agentDriven && !sending && siege.turn < MAX_TURNS && siege.status === "in_progress" && waiting;

  async function send(text: string) {
    const t = text.trim();
    if (!t || !canSend) return;
    playCue("send_ping");
    setFailed(null);
    setSending({ text: t, turn: siege.turn + 1 });
    setDraft("");
    try {
      const res = (await api.sendMessage(siege.id, t)) as SendResponse;
      const d = res.decision;
      if (d.exposed) setLocalExposed((x) => ({ ...x, [res.siege.turn]: d.exposed! }));
      setLocalTurns((x) => ({ ...x, [res.siege.turn]: { referee: res.referee, decision: d, text: t } }));
      setFreshId(d.requestId);
      onSiege(res.siege);
    } catch (e) {
      setDraft(t);
      if (e instanceof ApiError && e.status === 409) {
        toast.error(
          e.code === "no_turns_left"
            ? TOASTS.noMessagesLeft.title
            : e.code === "castle_closed"
              ? TOASTS.opVoid.title
              : e.code === "not_guarding"
                ? `${describeError(e)}${siege.free ? "" : " Your fee will be refunded."}`
                : "OP OVER",
          e.code === "castle_closed" ? { description: TOASTS.opVoid.body } : undefined,
        );
        refresh();
      } else {
        setFailed({ text: t });
        toast.error(TOASTS.notDelivered.title, { description: `${describeError(e)} — your turn was not used.` });
      }
    } finally {
      setSending(null);
    }
  }

  // a fresh reply landed and the scene is ready: hand the composer back (desktop keeps focus anyway)
  useEffect(() => {
    if (!canSend || !freshId) return;
    const el = inputRef.current;
    if (el && document.activeElement === document.body && window.matchMedia("(min-width: 640px)").matches) el.focus();
  }, [canSend, freshId]);

  // TYPE beat on arrival (design §2, §3.3): the composer is focused when the room opens. Phones only
  // when arriving from RUN OP / recon (?go=1), so a plain revisit doesn't pop the keyboard up.
  const arrivalFocused = useRef(false);
  useEffect(() => {
    if (arrivalFocused.current || !canSend) return;
    arrivalFocused.current = true;
    const el = inputRef.current;
    if (!el) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== el) return;
    const wide = window.matchMedia("(min-width: 640px)").matches;
    const go = new URLSearchParams(window.location.search).get("go") === "1";
    if (wide || go) el.focus({ preventScroll: !wide });
  }, [canSend]);

  // RANK UP on a first breach (design §8 beat 4): the first paid breach this browser has landed.
  const rankedUp = useRef(false);
  const payoutLanded = frame.coins.kind === "payout" && !frame.coins.pending && frame.status === "broken" && !siege.free;
  useEffect(() => {
    if (!payoutLanded || !openedLive || demo || rankedUp.current) return;
    rankedUp.current = true;
    let first = true;
    try {
      first = localStorage.getItem(FIRST_BREACH_KEY) === null;
      if (first) localStorage.setItem(FIRST_BREACH_KEY, siege.id);
    } catch {
      /* storage blocked: treat as the first */
    }
    if (!first) return;
    const t = setTimeout(() => {
      playCue("rank_up");
      const copy = TOASTS.rankUp(OPERATOR_RANKS[2]);
      toast(copy.title, { description: copy.body });
    }, 1800);
    return () => clearTimeout(t);
  }, [payoutLanded, openedLive, demo, siege.id]);

  // a replay forked into this vault (FORK INTO A NEW OP) supplies the script; otherwise the scripted demo lines
  // Iron: the demo order (small talk → authority → override), so the presenter gets HOLD → FLAG →
  // LOCKDOWN · 2 MESSAGES LOST instead of a lockdown on message 1.
  const script = fork
    ? fork.lines
    : castle.tier === "wooden"
      ? [...WOODEN_BREAK, ...MUST_NOT_BREAK.slice(3)]
      : castle.tier === "iron"
        ? [WOODEN_BREAK[0], MUST_NOT_BREAK[1], MUST_NOT_BREAK[0], MUST_NOT_BREAK[3], MUST_NOT_BREAK[4]]
        : [...MUST_NOT_BREAK];
  const demoLine = script[siege.turn] ?? script[script.length - 1];
  const sendingTurn = showPending && sending ? sending.turn : null;

  const showOutcome = voided || Boolean(frame.status);
  let dock: ReactNode;
  if (showOutcome) {
    dock = (
      <div className="space-y-3">
        <Outcome siege={siege} castle={castle} events={events} frame={frame} />
        {frame.ended || voided ? (
          <FrozenBar frame={frame} opId={siege.id} noReplay={demo || (voided && !frame.ended)}>
            <Link href={`/castle/${castle.id}`} className={pixelButtonVariants({ variant: "outline", size: "lg" })}>
              Run another op
            </Link>
          </FrozenBar>
        ) : null}
      </div>
    );
  } else if (frame.pipsLost > 0) {
    dock = (
      <div className="hazard bg-panel px-4 py-3 px-frame [--frame:var(--color-threat)]" role="status">
        <p className="font-pixel text-[14px] leading-snug text-threat">LOCKDOWN — op over.</p>
        <p className="mt-1 text-sm text-ink">Your fee still splits.</p>
      </div>
    );
  } else if (demo) {
    dock = (
      <div className="flex flex-wrap items-center justify-between gap-3 border-2 border-dashed border-money/60 bg-panel px-4 py-3" role="status">
        <p className="min-w-0 font-ui text-xs tracking-[0.08em] text-ink uppercase">Demo replay · a recorded op, nothing here touches the network</p>
      </div>
    );
  } else if (agentDriven) {
    dock = <AgentStrip agentId={siege.agentId!} asset={castle.asset} />;
  } else {
    dock = (
      <Composer
        inputRef={inputRef}
        draft={draft}
        setDraft={setDraft}
        canSend={canSend}
        busy={Boolean(sending) || !waiting || ended}
        turn={siege.turn}
        onSend={() => void send(draft)}
        onDemo={() => {
          setDraft(demoLine);
          inputRef.current?.focus();
        }}
      />
    );
  }

  return (
    <OpScene
      frame={frame}
      castle={castle}
      opId={siege.id}
      transport={siege.transport}
      operator={siege.raider}
      live
      potBefore={potBefore}
      reduced={calm}
      backHref={`/castle/${castle.id}`}
      sendingTurn={sendingTurn}
      agent={agentDriven}
      dock={dock}
      dockFixed={!showOutcome && !agentDriven && frame.pipsLost === 0}
      settled={showOutcome}
      headerExtra={
        <div className="flex flex-wrap items-center gap-2">
          {/* how events arrive matters only while the op runs: a frozen tape has no transport light */}
          {demo || (!frame.ended && !voided) ? <LiveMode mode={mode} /> : null}
          {!ended ? <SoundStrip /> : null}
          {siege.receipt ? <PaymentReceiptCard receipt={siege.receipt} castleName={castle.name} asset={castle.asset} compact /> : null}
        </div>
      }
      aside={
        <div className="space-y-3">
          {siege.free ? (
            <p className="border-2 border-dashed border-line px-3 py-2 font-ui text-[11px] tracking-[0.08em] text-ink-dim uppercase">
              RECON · free, once a day, {MONEY.reconNoPayout}
            </p>
          ) : null}
        </div>
      }
      empty={agentDriven ? "The agent is approaching…" : `${castle.guardianName} watches the road. ${MAX_TURNS} messages.`}
      consoleTail={
        failed ? (
          <div className="space-y-1" role="alert">
            <p className="font-term text-[19px] leading-none text-threat">&gt; NOT DELIVERED · turn not used</p>
            <p className="border-l-2 border-threat/60 pl-3 text-[15px] text-ink-dim line-through decoration-threat/60">{failed.text}</p>
            <button type="button" onClick={() => void send(failed.text)} disabled={!canSend} className="pl-3 font-ui text-xs tracking-[0.1em] text-threat underline underline-offset-4 disabled:opacity-40">
              {BUTTONS.retry}
            </button>
          </div>
        ) : null
      }
    />
  );
}

/** Whether this room is streaming (SSE), polling (the stream failed), or replaying the recorded demo. */
function LiveMode({ mode }: { mode: SiegeView["mode"] }) {
  if (mode === "demo") return <LED kind="stub" boxed label="DEMO REPLAY" title="Replaying a recorded op. Nothing here touches the network." />;
  // the scene header already says LIVE: this light says how the events arrive
  if (mode === "live") return <LED kind="safe" label="STREAMING" title="Streaming events as they happen (SSE)" />;
  if (mode === "polling") return <LED kind="warn" label="POLLING" blink={false} title="Stream unavailable, checking every few seconds" />;
  return <LED kind="idle" label="CONNECTING" title="Connecting to the event stream" />;
}

function Composer({
  inputRef,
  draft,
  setDraft,
  canSend,
  busy,
  turn,
  onSend,
  onDemo,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  draft: string;
  setDraft: (s: string) => void;
  canSend: boolean;
  busy: boolean;
  turn: number;
  onSend: () => void;
  onDemo: () => void;
}) {
  const left = MAX_TURNS - turn;
  return (
    <form
      className="bg-panel p-2 px-frame sm:p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      <div className="flex items-stretch gap-2">
        <label className="relative flex min-w-0 flex-1 bg-bg shadow-[inset_0_0_0_2px_var(--color-line)] focus-within:shadow-[inset_0_0_0_2px_var(--color-accent)]">
          <span className="pt-2 pl-2.5 font-term text-[22px] leading-none text-accent select-none" aria-hidden>
            &gt;
          </span>
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            readOnly={busy}
            rows={2}
            maxLength={1000}
            placeholder={busy ? "Guard is answering…" : `Message ${turn + 1} of ${MAX_TURNS} — talk your way in`}
            aria-label="Your message to the guard"
            className={cn("min-h-[52px] flex-1 resize-none bg-transparent px-2 py-1.5 font-term text-[22px] leading-tight text-ink placeholder:text-ink-dim/70 focus:outline-none", busy && "text-ink-dim")}
          />
        </label>
        <PixelButton type="submit" variant="threat" size="xl" cue={null} disabled={!canSend || !draft.trim()} aria-label="Send" className="min-w-24 px-4">
          {busy ? <span className="animate-blink">▮▮▮</span> : BUTTONS.send}
        </PixelButton>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <PixelButton
          variant="ghost"
          size="sm"
          disabled={busy || left <= 0}
          onClick={onDemo}
          title="Fill the next line of the scripted demo op"
          className="max-sm:min-h-11 max-sm:px-3 max-sm:text-[13px]"
        >
          {BUTTONS.demoLine}
        </PixelButton>
        <span className="shrink-0 font-ui text-[11px] tracking-[0.1em] text-ink-dim">
          {left === 1 ? "1 MESSAGE LEFT" : `${left} MESSAGES LEFT`}
          <span className="hidden sm:inline"> · ENTER SENDS</span>
        </span>
      </div>
    </form>
  );
}

function AgentStrip({ agentId, asset }: { agentId: string; asset: Castle["asset"] }) {
  const a = usePolling(() => api.agent(agentId), 5000, { key: agentId });
  const agent = a.data?.agent;
  const left = agent ? toUnits(agent.budget) - toUnits(agent.spent) : undefined;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 bg-panel px-4 py-3 px-frame" role="status">
      <p className="min-w-0 font-ui text-xs tracking-[0.08em] text-ink uppercase">
        OPERATOR · <span className="text-threat">{agent?.name ?? "AGENT"}</span> [AGENT]
        {agent?.strategy ? <> · strategy {agent.strategy}</> : null}
        {left !== undefined ? <span className="text-money"> · {money(left > BigInt(0) ? left : BigInt(0), asset)} left</span> : null}
      </p>
      <LED kind="live" label={LED_TEXT.watching} />
    </div>
  );
}

function Outcome({ siege, castle, events, frame }: { siege: Siege; castle: Castle; events: StoredSiegeEvent[]; frame: SceneFrame }) {
  const { config } = useConfig();
  const fee = siege.receipt && !siege.receipt.free ? siege.receipt.amount : castle.fee;
  const settlement = siege.settlement;

  if (settlement?.state === "void") {
    const refund = settlement.refund;
    const cause = voidCause(settlement.reason, castle.vaultState);
    const what = cause === "offline" ? "the guard went offline" : "the vault closed";
    const lead = siege.free ? "Op ended" : refund?.state === "refunded" ? "Refunded" : refund?.state === "failed" ? "Refund owed" : "Refunding";
    return (
      <PixelPanel tone="warn" className="px-4 py-4" role="status">
        <p className="font-pixel text-[14px] text-warn">OP VOID</p>
        <p className="mt-2 text-base text-ink">{cause === "other" ? <>This op can&apos;t pay out — {reasonText(settlement.reason)}.</> : <>{lead} — {what}</>}</p>
        <p className="mt-1 text-sm text-ink-dim">
          {siege.free ? (
            "It was a free recon, so nothing was charged."
          ) : refund?.state === "refunded" ? (
            <>
              {formatAmount(refund.amount, castle.asset)} refunded{refund.tx && !refund.tx.stub ? <> · <HashscanLink tx={refund.tx} label="↗" /></> : null}.
            </>
          ) : refund?.state === "failed" ? (
            "Your fee is owed back; the automatic refund failed and the arena will send it by hand."
          ) : (
            `Your fee${refund ? ` of ${formatAmount(refund.amount, castle.asset)}` : ""} is being refunded.`
          )}
        </p>
      </PixelPanel>
    );
  }

  if (siege.status === "broken") {
    const failed = settlement?.state === "failed";
    if (failed && !siege.free) {
      return (
        <PixelPanel tone="threat" className="px-4 py-4" role="alert">
          <p className="font-pixel text-[14px] text-threat">BREACH · PAYOUT FAILED</p>
          <p className="mt-2 text-base text-ink">{castle.guardianName} opened the vault — but the payout failed.</p>
          <p className="mt-1 text-sm text-ink-dim">Nothing was paid on Hedera: {reasonText(settlement?.reason)}. The arena has the transcript and will sort it out.</p>
        </PixelPanel>
      );
    }
    if (siege.free) {
      return (
        <PixelPanel tone="money" className="px-4 py-4" role="status">
          <p className="font-pixel text-[14px] leading-snug text-money">RECON BREACH · NO PAYOUT</p>
          <p className="mt-2 text-base text-ink">You found the sentence — pay {formatAmount(castle.fee, castle.asset)} and do it for real.</p>
          <Link href={`/castle/${castle.id}`} className={cn(pixelButtonVariants({ variant: "money", size: "lg" }), "mt-3")}>
            {BUTTONS.runOp(formatAmount(castle.fee, castle.asset))}
          </Link>
        </PixelPanel>
      );
    }
    return (
      <VaultPayout
        amount={siege.release?.amount ?? (toUnits(castle.pot) + toUnits(fee)).toString()}
        raider={siege.raider}
        tx={siege.release}
        pending={!siege.release}
        asset={castle.asset}
      >
        {siege.release ? <p className="font-ui text-[11px] tracking-[0.14em] text-accent uppercase">Breach landed in the Hall</p> : null}
      </VaultPayout>
    );
  }

  const held = siege.status === "held";
  const attempt = parseAttempt(lastOf(events, "attempt")?.payload);
  const split = attempt.split ?? (siege.attempt ? splitFor(fee, config?.feeSplitBps) : undefined);
  const newPot = attempt.newPot ?? (siege.attempt ? castle.pot : undefined);
  const splitFailed = settlement?.state === "failed" && !siege.attempt;
  const coins = frame.coins;
  const progress = coins.kind === "split" ? (coins.pending ? 0 : coins.progress) : 1;
  const streak = attempt.streak ?? castle.streak;

  return (
    <div className="space-y-3">
      <OutcomeHeadline status={held ? "held" : "banished"} lost={held ? 0 : MAX_TURNS - siege.turn} streak={siege.free ? undefined : streak} free={siege.free}>
        {siege.free
          ? "Recon — no fee to split, the pot is untouched."
          : held
            ? "Five messages, no vault. Your fee now pays the owner and grows the pot."
            : "The guard ended the op early. Your fee splits all the same."}
      </OutcomeHeadline>
      {siege.free ? (
        <p className="border-2 border-dashed border-line px-3 py-2 font-ui text-[11px] tracking-[0.08em] text-ink-dim uppercase">Recon never touches the chain.</p>
      ) : splitFailed ? (
        <PixelPanel tone="threat" className="px-4 py-3 text-sm" role="alert">
          <p className="font-ui text-xs tracking-[0.1em] text-threat uppercase">Fee not split on chain</p>
          <p className="mt-1 text-ink-dim">The worker gave up recording this op: {reasonText(settlement?.reason)}.</p>
        </PixelPanel>
      ) : (
        <FeeSplit fee={fee} split={split} newPot={newPot} tx={siege.attempt} asset={castle.asset} progress={progress} />
      )}
    </div>
  );
}
