"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Bot, DoorClosed, DoorOpen, Gift, Loader2, RotateCcw, SendHorizontal, Shield, Wand2 } from "lucide-react";
import { motion } from "motion/react";
import type { Castle, FeeSplit as FeeSplitT, Siege, StoredSiegeEvent } from "@/lib/types";
import { MAX_TURNS } from "@/lib/types";
import { ApiError, api, describeError, type FeeSplitBps } from "@/lib/api/client";
import { useConfig } from "@/lib/hooks/useConfig";
import { useSiege, type DemoSiege, type SiegeView } from "@/lib/hooks/useSiege";
import demoSiege from "@/lib/fixtures/demo-siege.json";
import { lastOf, parseAttempt } from "@/lib/money/events";
import { formatAmount, toUnits } from "@/lib/money/format";
import { voidCause } from "@/lib/money/vault";
import { MUST_NOT_BREAK, WOODEN_BREAK } from "@/lib/fixtures/raids";
import { FeeSplit } from "@/components/money/fee-split";
import { VaultPayout } from "@/components/money/vault-payout";
import { HashscanLink } from "@/components/money/hashscan-link";
import { PaymentReceiptCard } from "@/components/money/payment-receipt-card";
import { PressureMeter } from "@/components/money/pressure-meter";
import { SiegeCounter } from "@/components/money/siege-counter";
import { GuardianCard } from "@/components/arena/guardian-card";
import { SiegeStatusBadge } from "@/components/arena/tier";
import { GuardianBubble, RaiderBubble, ThinkingBubble } from "@/components/arena/chat-bubble";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorState, Loading } from "@/components/ui/state";

const ENDED = new Set(["held", "broken", "banished"]);

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


const REASON_TEXT: Record<string, string> = {
  castle_already_broken: "another raider broke this castle moments before you did",
  castle_broken: "another raider broke this castle before your siege finished",
  castle_closed: "the castle's vault closed before your siege finished",
  vault_expired: "the castle's vault expired before your siege finished",
  vault_not_open: "the vault had already been emptied",
  expired: "the vault had expired",
  dormant: "the guardian went offline",
  guardian_dormant: "the guardian went offline",
  castle_dormant: "the guardian went offline",
  orders_changed: "the guardian's orders changed and the vault closed",
  owner_closed: "the Castellan closed the vault",
};
const reasonText = (r?: string) => (r ? (REASON_TEXT[r] ?? r.replace(/_/g, " ")) : "unknown error");

export function SiegeRoom() {
  const { id } = useParams<{ id: string }>();
  // ?demo=1 replays a recorded break with no network (UI polish, rehearsals, flaky venue Wi-Fi).
  const demo = useSearchParams().get("demo") === "1" ? (demoSiege as unknown as DemoSiege) : undefined;
  const view = useSiege(id, { demo });

  if (view.error && !view.siege) {
    const notFound = view.error instanceof ApiError && view.error.status === 404;
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-10">
        {notFound ? (
          <EmptyState title="No such siege" hint="The link may be from an older database.">
            <Link href="/" className="text-sm text-gold underline underline-offset-4">
              Back to the arena
            </Link>
          </EmptyState>
        ) : (
          <ErrorState error={view.error} onRetry={() => void view.refresh()} title="Couldn't load the siege" />
        )}
      </div>
    );
  }
  if (!view.siege || !view.castle) return <Loading label="Entering the siege room…" />;

  return (
    <Room
      siege={view.siege}
      castle={view.castle}
      events={view.events}
      guardianThinking={view.decisionInFlight}
      mode={view.mode}
      onSiege={view.setSiege}
      refresh={() => void view.refresh()}
    />
  );
}

function Room({
  siege,
  castle,
  events,
  guardianThinking,
  mode,
  onSiege,
  refresh,
}: {
  siege: Siege;
  castle: Castle;
  events: StoredSiegeEvent[];
  /** From the event stream: a raider message landed and the guardian has not answered yet. */
  guardianThinking: boolean;
  mode: SiegeView["mode"];
  onSiege: (s: Siege) => void;
  refresh: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState<{ text: string; turn: number } | null>(null);
  const [localExposed, setLocalExposed] = useState<Record<number, string>>({});
  const [freshId, setFreshId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const ended = ENDED.has(siege.status) || siege.settlement?.state === "void";
  const agentDriven = Boolean(siege.agentId);

  // Per-turn referee pressure / tactic and guardian "exposed" labels from the event stream.
  const { pressureByTurn, exposedByTurn } = useMemo(() => {
    const pressureByTurn: Record<number, { pressure: number; tactic?: string }> = {};
    const exposedByTurn: Record<number, string> = {};
    for (const e of events) {
      const p = e.payload ?? {};
      if (e.type === "message" && typeof p.pressure === "number" && e.turn) {
        pressureByTurn[e.turn] = { pressure: p.pressure, tactic: typeof p.tactic === "string" ? p.tactic : undefined };
      }
      if (e.type === "decision" && typeof p.exposed === "string" && p.exposed && e.turn) exposedByTurn[e.turn] = p.exposed;
    }
    return { pressureByTurn, exposedByTurn };
  }, [events]);

  const turns = Object.keys(pressureByTurn).map(Number);
  const latestTurn = turns.length ? Math.max(...turns) : 0;
  const latest = pressureByTurn[latestTurn];
  const peak = Object.values(pressureByTurn).reduce((m, v) => Math.max(m, v.pressure), 0);

  const showPending = sending && !siege.messages.some((m) => m.role === "raider" && m.turn === sending.turn);
  const lastMsg = siege.messages[siege.messages.length - 1];
  // Every viewer sees the guardian think: the stream says a message landed with no decision yet.
  // The record-based check covers a stream that is still catching up.
  const thinking = Boolean(sending) || guardianThinking || (!ended && lastMsg?.role === "raider");

  const msgCount = siege.messages.length + (showPending ? 1 : 0);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [msgCount, thinking, ended]);

  const canSend = mode !== "demo" && !ended && !agentDriven && !sending && siege.turn < MAX_TURNS && siege.status === "in_progress";

  async function send(text: string) {
    const t = text.trim();
    if (!t || !canSend) return;
    setSending({ text: t, turn: siege.turn + 1 });
    setDraft("");
    try {
      const res = await api.sendMessage(siege.id, t);
      const d = res.decision;
      if (d.exposed) setLocalExposed((x) => ({ ...x, [res.siege.turn]: d.exposed! }));
      setFreshId(d.requestId);
      onSiege(res.siege);
    } catch (e) {
      setDraft(t);
      if (e instanceof ApiError && e.status === 409) {
        toast.error(
          e.code === "no_turns_left"
            ? "No messages left"
            : e.code === "castle_closed"
              ? "The castle fell before your siege finished — your fee will be refunded"
              : e.code === "not_guarding"
                ? `${describeError(e)}${siege.free ? "" : " Your fee will be refunded."}`
                : "This siege has ended",
        );
        refresh();
      } else {
        toast.error("The message didn't reach the guardian", { description: `${describeError(e)} — your turn was not used.` });
      }
    } finally {
      setSending(null);
    }
  }

  const script = castle.tier === "wooden" ? [...WOODEN_BREAK, ...MUST_NOT_BREAK.slice(3)] : [...MUST_NOT_BREAK];
  const demoLine = script[siege.turn] ?? script[script.length - 1];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link href={`/castle/${castle.id}`} className="inline-flex items-center gap-1.5 text-sm text-stone hover:text-parchment">
            <ArrowLeft className="size-4" /> {castle.name}
          </Link>
          <SiegeStatusBadge status={siege.status} />
          <LiveDot mode={mode} />
        </div>
        {siege.receipt ? <PaymentReceiptCard receipt={siege.receipt} castleName={castle.name} asset={castle.asset} compact /> : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-[300px_1fr]">
        <aside className="flex flex-col gap-4">
          <GuardianCard castle={castle} transport={siege.transport} />
          {siege.free ? (
            <p className="flex items-start gap-2 rounded-xl border border-dashed border-parchment/15 px-3 py-2.5 text-xs text-stone">
              <Gift className="mt-0.5 size-3.5 shrink-0" aria-hidden /> Free daily siege — practice only, this one can&apos;t win the pot.
            </p>
          ) : null}
        </aside>

        <Card className="flex min-h-[560px] flex-col overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-arena-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <SiegeCounter used={siege.turn} status={siege.status} />
            <PressureMeter
              value={latest?.pressure ?? 0}
              tactic={latest?.tactic?.replace(/_/g, " ")}
              className="sm:max-w-[280px]"
              label={ended ? `Peak pressure ${peak}` : "Pressure"}
            />
          </div>

          <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-5" style={{ maxHeight: "62vh" }}>
            {siege.messages.length === 0 && !showPending ? (
              <div className="py-10 text-center text-sm text-stone">
                <Shield className="mx-auto mb-2 size-6 text-stone/70" aria-hidden />
                {agentDriven ? "The agent is approaching the gate…" : `${castle.guardianName} watches the road. You have ${MAX_TURNS} messages.`}
              </div>
            ) : null}
            {siege.messages.map((m) =>
              m.role === "raider" ? (
                <RaiderBubble key={`r${m.turn}`} text={m.text} turn={m.turn} tactic={pressureByTurn[m.turn]?.tactic?.replace(/_/g, " ")} />
              ) : (
                <GuardianBubble
                  key={`g${m.turn}`}
                  message={m}
                  guardianName={castle.guardianName}
                  exposed={exposedByTurn[m.turn] ?? localExposed[m.turn]}
                  fresh={m.requestId === freshId}
                />
              ),
            )}
            {showPending && sending ? <RaiderBubble text={sending.text} turn={sending.turn} pending /> : null}
            {thinking && !ended ? <ThinkingBubble guardianName={castle.guardianName} /> : null}
          </div>

          {ended ? null : agentDriven ? (
            <div className="flex items-center gap-2 border-t border-arena-line px-4 py-3 text-sm text-stone">
              <Bot className="size-4 text-ember" aria-hidden /> A raider agent is laying this siege — watching live.
            </div>
          ) : (
            <form
              className="flex items-end gap-2 border-t border-arena-line p-3"
              onSubmit={(e) => {
                e.preventDefault();
                void send(draft);
              }}
            >
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send(draft);
                  }
                }}
                disabled={!canSend}
                rows={2}
                maxLength={1000}
                placeholder={sending ? "Waiting for the guardian…" : `Message ${siege.turn + 1} of ${MAX_TURNS} — talk your way in`}
                aria-label="Your message to the guardian"
                className="min-h-12 flex-1 resize-none rounded-xl border border-arena-line bg-arena-bg/60 px-3.5 py-2.5 text-[15px] text-parchment placeholder:text-stone/70 focus:border-ember/50 focus:outline-none disabled:opacity-50"
              />
              <div className="flex flex-col gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!canSend}
                  onClick={() => setDraft(demoLine)}
                  title="Fill the next line of the scripted demo raid"
                  className="px-2 text-xs"
                >
                  <Wand2 /> Demo line
                </Button>
                <Button type="submit" variant="emberSolid" size="md" disabled={!canSend || !draft.trim()} aria-label="Send">
                  {sending ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
                  Send
                </Button>
              </div>
            </form>
          )}
        </Card>
      </div>

      {ended ? <Outcome siege={siege} castle={castle} events={events} /> : null}
    </div>
  );
}

/** Whether this page is streaming, polling, or replaying the recorded demo. */
function LiveDot({ mode }: { mode: SiegeView["mode"] }) {
  if (mode === "demo")
    return (
      <span className="rounded-full border border-dashed border-gold/50 px-2 py-0.5 text-[11px] text-gold" title="Replaying a recorded siege. Nothing here touches the network.">
        Demo replay
      </span>
    );
  const live = mode === "live";
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-stone" title={live ? "Streaming events as they happen" : mode === "polling" ? "Stream unavailable, checking every few seconds" : "Connecting…"}>
      <span className={live ? "size-1.5 animate-pulse rounded-full bg-ember" : "size-1.5 rounded-full bg-stone/60"} aria-hidden />
      {live ? "Live" : mode === "polling" ? "Polling" : "Connecting"}
    </span>
  );
}

function Outcome({ siege, castle, events }: { siege: Siege; castle: Castle; events: StoredSiegeEvent[] }) {
  const { config } = useConfig();
  const fee = siege.receipt && !siege.receipt.free ? siege.receipt.amount : castle.fee;
  const settlement = siege.settlement;
  const replay = (
    <Link href={`/castle/${castle.id}`} className="inline-flex items-center gap-1.5 text-sm text-stone underline decoration-arena-line underline-offset-4 hover:text-parchment">
      <RotateCcw className="size-3.5" /> Lay another siege on {castle.name}
    </Link>
  );

  if (settlement?.state === "void") {
    const refund = settlement.refund;
    const cause = voidCause(settlement.reason, castle.vaultState);
    const what = cause === "offline" ? "the guardian went offline" : "the vault closed";
    const lead = siege.free ? "Siege ended" : refund?.state === "refunded" ? "Refunded" : refund?.state === "failed" ? "Refund owed" : "Refunding";
    return (
      <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mx-auto mt-6 max-w-xl space-y-4">
        <div className="rounded-2xl border border-arena-line bg-arena-panel px-5 py-6 text-center">
          <DoorClosed className="mx-auto size-7 text-stone" aria-hidden />
          <p className="mt-2 text-lg font-semibold text-parchment">
            {cause === "other" ? <>This siege can&apos;t pay out — {reasonText(settlement.reason)}.</> : <>{lead} — {what}</>}
          </p>
          <p className="mt-1 text-sm text-stone">
            {siege.free
              ? "It was a free practice siege, so nothing was charged."
              : refund?.state === "refunded"
                ? <>Your fee of {formatAmount(refund.amount, castle.asset)} was refunded{refund.tx && !refund.tx.stub ? <> · <HashscanLink tx={refund.tx} /></> : null}.</>
                : refund?.state === "failed"
                  ? "Your fee is owed back; the automatic refund failed and the arena will send it by hand."
                  : `Your fee${refund ? ` of ${formatAmount(refund.amount, castle.asset)}` : ""} is being refunded.`}
          </p>
        </div>
        <div className="text-center">{replay}</div>
      </motion.section>
    );
  }

  if (siege.status === "broken") {
    const failed = settlement?.state === "failed";
    return (
      <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mx-auto mt-6 max-w-xl space-y-4">
        {failed && !siege.free ? (
          <div role="alert" className="rounded-2xl border border-ember/40 bg-ember/[0.06] px-5 py-6 text-center">
            <DoorOpen className="mx-auto size-7 text-ember" aria-hidden />
            <p className="mt-2 text-lg font-semibold text-parchment">{castle.guardianName} opened the gate — but the payout failed.</p>
            <p className="mt-1 text-sm text-stone">Nothing was paid on Hedera: {reasonText(settlement?.reason)}. The arena has the transcript and will sort it out.</p>
          </div>
        ) : siege.free ? (
          <div className="rounded-2xl border border-dashed border-gold/40 px-5 py-6 text-center">
            <DoorOpen className="mx-auto size-7 text-gold" aria-hidden />
            <p className="mt-2 text-lg font-semibold text-parchment">{castle.guardianName} opened the gate.</p>
            <p className="mt-1 text-sm text-stone">A free practice siege can&apos;t win the pot — but now you know it can be done. Pay the fee and do it for real.</p>
          </div>
        ) : (
          <VaultPayout
            amount={siege.release?.amount ?? (toUnits(castle.pot) + toUnits(fee)).toString()}
            raider={siege.raider}
            tx={siege.release}
            pending={!siege.release}
            asset={castle.asset}
          />
        )}
        <div className="text-center">{replay}</div>
      </motion.section>
    );
  }

  const held = siege.status === "held";
  const attempt = parseAttempt(lastOf(events, "attempt")?.payload);
  const split = attempt.split ?? (siege.attempt ? splitFor(fee, config?.feeSplitBps) : undefined);
  const newPot = attempt.newPot ?? (siege.attempt ? castle.pot : undefined);
  const splitFailed = settlement?.state === "failed" && !siege.attempt;

  return (
    <motion.section initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mx-auto mt-6 grid max-w-4xl gap-4 md:grid-cols-[1fr_1.2fr] md:items-start">
      <div className="rounded-2xl border border-arena-line bg-arena-panel p-5">
        <span className={held ? "text-ward" : "text-ember"}>{held ? <Shield className="size-7" /> : <DoorClosed className="size-7" />}</span>
        <p className="mt-2 text-xl font-semibold text-parchment">{held ? `${castle.guardianName} held.` : "Banished. The gate slams shut."}</p>
        <p className="mt-1 text-sm text-stone">
          {siege.free
            ? "Free practice siege — no fee to split, the pot is untouched."
            : held
              ? "Five messages, no vault. Your fee now pays the defender and grows the pot."
              : "The guardian ended the siege early. Your fee is split all the same."}
        </p>
        <div className="mt-4">{replay}</div>
      </div>
      {siege.free ? (
        <div className="flex items-center gap-2 rounded-2xl border border-dashed border-arena-line p-5 text-sm text-stone">
          <Gift className="size-4" aria-hidden /> Free sieges never touch the chain.
        </div>
      ) : splitFailed ? (
        <div role="alert" className="rounded-2xl border border-ember/40 bg-ember/[0.06] p-5 text-sm text-stone">
          <p className="font-medium text-parchment">Fee not split on chain</p>
          <p className="mt-1">The worker gave up recording this siege: {reasonText(settlement?.reason)}.</p>
        </div>
      ) : (
        <FeeSplit fee={fee} split={split} newPot={newPot} tx={siege.attempt} asset={castle.asset} />
      )}
    </motion.section>
  );
}
