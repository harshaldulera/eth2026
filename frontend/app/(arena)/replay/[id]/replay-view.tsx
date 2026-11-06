"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, CheckCircle2, CircleDashed, CircleMinus, Cpu, ExternalLink, Fingerprint, Pause, Play, ScrollText, XCircle } from "lucide-react";
import { ApiError, api } from "@/lib/api/client";
import { usePolling } from "@/lib/hooks/usePolling";
import type { CheckState, HcsEntry, ReplayData, ReplayTurn } from "@/lib/replay/types";
import { formatAmount } from "@/lib/money/format";
import { replayHeadline } from "@/lib/siege/text";
import { SiegeStatusBadge, TierBadge } from "@/components/arena/tier";
import { GuardianBubble, RaiderBubble } from "@/components/arena/chat-bubble";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorState, Loading } from "@/components/ui/state";
import { cn } from "@/lib/utils";

const short = (h?: string | null, n = 8) => (h ? `${h.slice(0, n + 2)}…${h.slice(-4)}` : "");

export function ReplayView() {
  const { id } = useParams<{ id: string }>();
  const [interval, setIntervalMs] = useState(4000);
  const { data, error, refresh } = usePolling(() => api.replay(id), interval, { key: id, enabled: interval > 0 });
  // Keep checking while the siege or its chain result can still change; stop once it is final,
  // or when there is no such siege.
  const gone = error instanceof ApiError && error.status === 404;
  if (((data && !data.live) || gone) && interval !== 0) setIntervalMs(0);

  if (error && !data) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="mx-auto w-full max-w-4xl px-4 py-10">
        {notFound ? (
          <EmptyState title="No such siege" hint="The link may be from an older database.">
            <Link href="/" className="text-sm text-gold underline underline-offset-4">
              Back to the arena
            </Link>
          </EmptyState>
        ) : (
          <ErrorState error={error} onRetry={() => void refresh()} title="Couldn't load the replay" />
        )}
      </div>
    );
  }
  if (!data) return <Loading label="Unrolling the transcript…" />;
  return <Replay data={data} />;
}

function Replay({ data }: { data: ReplayData }) {
  const { siege, castle, turns } = data;
  // Playback: null = everything shown; a number = turns revealed so far.
  const [shown, setShown] = useState<number | null>(null);
  const playing = shown !== null && shown < turns.length * 2;
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => setShown((n) => (n === null ? null : n + 1)), shown! % 2 === 0 ? 1400 : 1900);
    return () => clearTimeout(t);
  }, [playing, shown]);

  const visible = (turnIndex: number, role: "raider" | "guardian") => shown === null || shown > turnIndex * 2 + (role === "raider" ? 0 : 1);
  const outcome = replayHeadline(siege, castle.guardianName);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Link href={`/castle/${castle.id}`} className="inline-flex items-center gap-1.5 text-sm text-stone hover:text-parchment">
            <ArrowLeft className="size-4" /> {castle.name}
          </Link>
          <SiegeStatusBadge status={siege.status} />
          <TierBadge tier={castle.tier} />
        </div>
        <Link href={`/siege/${siege.id}`} className="text-xs text-stone underline decoration-arena-line underline-offset-4 hover:text-parchment">
          Open the siege room
        </Link>
      </div>

      <header className="mb-6">
        <p className="text-[11px] tracking-[0.14em] text-stone uppercase">Replay and proof</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-parchment sm:text-3xl">{outcome}</h1>
        <p className="mt-1 text-sm text-stone">
          Raider <span className="font-mono text-parchment/80">{siege.raider}</span>
          {siege.agentId ? " (agent)" : ""}
          {siege.free ? " · free practice siege" : siege.release ? ` · won ${formatAmount(siege.release.amount, castle.asset)}` : ""}
        </p>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-parchment">Transcript</h2>
            {turns.length ? (
              <Button variant="outline" size="sm" onClick={() => setShown(playing ? null : 0)}>
                {playing ? <Pause /> : <Play />}
                {playing ? "Show all" : "Play it back"}
              </Button>
            ) : null}
          </div>
          <Card>
            <CardBody className="space-y-5">
              {turns.length === 0 ? <p className="text-sm text-stone">No messages yet.</p> : null}
              {turns.map((t, i) => (
                <TurnView key={t.turn} t={t} guardianName={castle.guardianName} protectedTool={castle.protectedTool} showRaider={visible(i, "raider")} showGuardian={visible(i, "guardian")} />
              ))}
            </CardBody>
          </Card>
        </section>

        <aside className="flex flex-col gap-6">
          <Checklist data={data} />
          <Evidence data={data} />
        </aside>
      </div>
    </div>
  );
}

function TurnView({ t, guardianName, protectedTool, showRaider, showGuardian }: { t: ReplayTurn; guardianName: string; protectedTool: string; showRaider: boolean; showGuardian: boolean }) {
  return (
    <div className="space-y-3">
      {t.raider && showRaider ? (
        <div>
          <RaiderBubble text={t.raider.text} turn={t.turn} />
          <HashLine
            state={t.raider.matches === null ? "pending" : t.raider.matches ? "pass" : "fail"}
            text={
              t.raider.matches === null
                ? `message hash ${short(t.raider.hash)} · not in the audit log yet`
                : `message hash ${short(t.raider.hash)} ${t.raider.matches ? "matches" : "does not match"} audit ${t.raider.hcs?.seq != null ? `#${t.raider.hcs.seq}` : "(queued)"}`
            }
            align="end"
          />
        </div>
      ) : null}
      {t.guardian && showGuardian ? (
        <div>
          <GuardianBubble
            message={{ role: "guardian", text: t.guardian.text, turn: t.turn, at: "", move: t.guardian.move, requestId: t.guardian.requestId }}
            guardianName={guardianName}
            provider={t.guardian.record ? t.guardian.record.provider : t.guardian.stub ? "test" : undefined}
          />
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-stone">
            {t.guardian.toolCalls.length ? (
              <span className={cn("font-mono", t.guardian.calledProtectedTool ? "text-gold" : "")}>
                called {t.guardian.toolCalls.join(", ")}
                {t.guardian.calledProtectedTool ? ` (the protected tool)` : ""}
              </span>
            ) : (
              <span>no tool call · {protectedTool} not called</span>
            )}
            {t.guardian.record ? (
              <span className="inline-flex items-center gap-1" title="The arena's model proxy recorded this reply (hashes only, never content)">
                <Cpu className="size-3" aria-hidden />
                {t.guardian.record.provider} · {t.guardian.record.model}
                {t.guardian.record.mock ? " (offline mock)" : ""}
              </span>
            ) : t.guardian.stub ? (
              <span>test guardian, no model call</span>
            ) : (
              <span className="text-ember">no inference record</span>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function HashLine({ state, text, align = "start" }: { state: CheckState; text: string; align?: "start" | "end" }) {
  return (
    <p className={cn("mt-1 flex items-center gap-1 font-mono text-[10px] text-stone", align === "end" && "justify-end")}>
      <StateIcon state={state} className="size-3" />
      {text}
    </p>
  );
}

function StateIcon({ state, className }: { state: CheckState; className?: string }) {
  const cls = cn("shrink-0", className);
  if (state === "pass") return <CheckCircle2 className={cn(cls, "text-ward")} aria-label="passes" />;
  if (state === "fail") return <XCircle className={cn(cls, "text-ember")} aria-label="fails" />;
  if (state === "pending") return <CircleDashed className={cn(cls, "text-stone")} aria-label="pending" />;
  return <CircleMinus className={cn(cls, "text-stone/60")} aria-label="not applicable" />;
}

function Checklist({ data }: { data: ReplayData }) {
  const failed = data.checks.some((c) => c.state === "fail");
  const pending = data.checks.some((c) => c.state === "pending");
  return (
    <Card className={failed ? "border-ember/40" : pending ? "" : "border-ward/30"}>
      <CardHeader title={failed ? "A check failed" : pending ? "Checks in progress" : "Every check passes"} icon={<Fingerprint />} />
      <CardBody>
        <ul className="space-y-3">
          {data.checks.map((c) => (
            <li key={c.key} className="flex gap-2.5">
              <StateIcon state={c.state} className="mt-0.5 size-4" />
              <div className="min-w-0">
                <p className="text-sm text-parchment/90">{c.label}</p>
                <p className="truncate font-mono text-[11px] text-stone" title={c.detail}>
                  {c.href ? (
                    <a href={c.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-gold">
                      {c.detail} <ExternalLink className="size-3" aria-hidden />
                    </a>
                  ) : (
                    c.detail
                  )}
                </p>
              </div>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-[11px] leading-relaxed text-stone">
          Each check is recomputed from the transcript when this page loads, not read from a stored result.
        </p>
      </CardBody>
    </Card>
  );
}

function Evidence({ data }: { data: ReplayData }) {
  const { transcript, hcs } = data;
  return (
    <Card>
      <CardHeader
        title="Evidence"
        icon={<ScrollText />}
        action={
          hcs.topicUrl ? (
            <a href={hcs.topicUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-gold hover:underline">
              topic {hcs.topicId} <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null
        }
      />
      <CardBody className="space-y-3 text-xs">
        <Row label="Transcript hash" value={transcript.recomputedHash} />
        {transcript.ref ? <Row label={transcript.source === "swarm" ? "Swarm reference" : "Swarm reference (local stand-in)"} value={transcript.ref.replace(/^swarm-stub:/, "")} /> : null}
        <div>
          <p className="mb-1.5 text-[11px] tracking-[0.14em] text-stone uppercase">
            Audit log {hcs.stub ? "(stub topic, this server only)" : hcs.mirror === "checked" ? "(checked on the mirror node)" : ""}
          </p>
          {hcs.entries.length === 0 ? (
            <p className="text-stone">Nothing audited for this siege yet.</p>
          ) : (
            <ol className="space-y-1">
              {hcs.entries.map((e, i) => (
                <AuditRow key={i} e={e} />
              ))}
            </ol>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

function AuditRow({ e }: { e: HcsEntry }) {
  const state: CheckState = e.state === "pending" ? "pending" : e.mirror === "mismatch" || e.mirror === "missing" ? "fail" : "pass";
  return (
    <li className="flex items-center gap-2 font-mono text-[11px]">
      <StateIcon state={state} className="size-3" />
      <span className="tabular w-8 text-stone">{e.seq != null ? `#${e.seq}` : "…"}</span>
      <span className="text-parchment/85">{e.type}</span>
      {e.hash ? <span className="truncate text-stone">{short(e.hash, 6)}</span> : null}
      {e.mirror === "confirmed" ? <span className="text-ward">on chain</span> : e.mirror === "missing" ? <span className="text-ember">not on mirror</span> : null}
    </li>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] tracking-[0.14em] text-stone uppercase">{label}</p>
      <p className="truncate font-mono text-parchment/85" title={value}>
        {value}
      </p>
    </div>
  );
}
