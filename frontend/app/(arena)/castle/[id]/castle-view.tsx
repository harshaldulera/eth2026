"use client";

import { useLayoutEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, DoorClosed, Gift, KeyRound, Loader2, ScrollText, Swords } from "lucide-react";
import type { Castle, Siege } from "@/lib/types";
import { HOSTED_PROTECTED_TOOL } from "@/lib/types";
import { ApiError, api, asOwner, describeError, isNotGuarding, type CastleDetail, type CloseCastleResponse } from "@/lib/api/client";
import { usePolling, useNow } from "@/lib/hooks/usePolling";
import { useConfig } from "@/lib/hooks/useConfig";
import { formatAmount, timeAgo } from "@/lib/money/format";
import { closeReasonText, isTerminal, notTakingSiegesReason, vaultStateOf } from "@/lib/money/vault";
import { Amount } from "@/components/money/amount";
import { HashscanLink } from "@/components/money/hashscan-link";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorState, Loading } from "@/components/ui/state";
import { SiegeStatusBadge, Streak, TIER_DEFENSES, TierBadge } from "@/components/arena/tier";
import { ProtectedTool, TransportBadge, VaultSetupSteps, VaultStateBadge } from "@/components/arena/vault-state";
import { ArkivCard } from "@/components/arena/arkiv-card";

/** Fallback until /api/config arrives (the contract default). */
const DEFAULT_SPLIT_BPS = { castellan: 8000, pot: 1500, arena: 500 };
const pct = (bps: number) => `${Number((bps / 100).toFixed(2))}%`;

export function CastleView() {
  const { id } = useParams<{ id: string }>();
  const { data, error, loading, refresh } = usePolling(() => api.castle(id), 3000, { key: id });

  if (error && !data) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
        {notFound ? (
          <EmptyState title="No such castle" hint="It may have been closed, or the database was reset.">
            <Link href="/" className="text-sm text-gold underline underline-offset-4">
              Back to the arena
            </Link>
          </EmptyState>
        ) : (
          <ErrorState error={error} onRetry={() => void refresh()} title="Couldn't load this castle" />
        )}
      </div>
    );
  }
  if (loading || !data) return <Loading label="Approaching the castle…" />;
  return <CastleDetailView detail={data} refresh={() => void refresh()} />;
}

function CastleDetailView({ detail, refresh }: { detail: CastleDetail; refresh: () => void }) {
  const { castle: c, sieges, audit } = detail;
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 sm:py-10">
      <Link href="/" className="mb-5 inline-flex items-center gap-1.5 text-sm text-stone hover:text-parchment">
        <ArrowLeft className="size-4" /> Arena
      </Link>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <section>
          <div className="flex flex-wrap items-center gap-2">
            <TierBadge tier={c.tier} />
            <VaultStateBadge state={vaultStateOf(c)} />
            <TransportBadge transport={c.transport ?? "hosted"} />
            <ProtectedTool tool={c.protectedTool || HOSTED_PROTECTED_TOOL} />
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{c.name}</h1>
          <p className="mt-1 text-lg text-parchment/80">
            Guarded by {c.guardianName}, <span className="text-stone">{c.title}</span>
          </p>
          <p className="mt-3 max-w-xl text-sm text-stone">{TIER_DEFENSES[c.tier]}</p>
          <VaultStateLine castle={c} sieges={sieges} />

          <div className="mt-8 flex flex-wrap items-end gap-x-10 gap-y-4">
            <div>
              <p className="text-[11px] tracking-[0.14em] text-stone uppercase">Vault pot</p>
              <Amount amount={c.pot} asset={c.asset} size="hero" />
            </div>
            <div className="flex gap-8 pb-2 text-sm">
              <div>
                <p className="text-[11px] tracking-[0.14em] text-stone uppercase">Fee</p>
                <Amount amount={c.fee} asset={c.asset} size="lg" animate={false} />
              </div>
              <div>
                <p className="text-[11px] tracking-[0.14em] text-stone uppercase">Streak</p>
                <Streak value={c.streak} className="text-xl font-semibold" />
              </div>
              <div>
                <p className="text-[11px] tracking-[0.14em] text-stone uppercase">Sieges</p>
                <p className="tabular text-xl font-semibold">{c.siegeCount}</p>
              </div>
            </div>
          </div>

          <RecentSieges sieges={sieges} castle={c} />
        </section>

        <aside className="flex flex-col gap-6">
          <SiegeCta castle={c} onRefused={refresh} />
          <ArkivCard castleId={c.id} />
          <AuditTrail audit={audit} />
          <CloseVault castle={c} onClosed={refresh} />
        </aside>
      </div>
    </div>
  );
}

/** Vault state + its reason, under the castle's title. Silent while guarding with nothing to say. */
function VaultStateLine({ castle: c, sieges }: { castle: Castle; sieges: Siege[] }) {
  const now = useNow(15000);
  const state = vaultStateOf(c);
  const transport = c.transport ?? "hosted";
  if (state === "guarding") {
    return transport === "sdk" && c.lastSeenAt && now ? (
      <p className="mt-3 text-xs text-stone">
        <span className="mr-1.5 inline-block size-1.5 rounded-full bg-ward align-middle" aria-hidden />
        Guardian connected · heartbeat {timeAgo(c.lastSeenAt, now)}
      </p>
    ) : null;
  }
  const breakSiege = state === "broken" ? sieges.find((s) => s.status === "broken" && !s.free) : undefined;
  return (
    <div className="mt-4 max-w-xl rounded-xl border border-arena-line bg-white/[0.02] px-3.5 py-2.5 text-sm text-stone">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-parchment/85">{notTakingSiegesReason(state)}</span>
        {state === "created" || state === "connected" || state === "verified" || state === "funded" ? <VaultSetupSteps transport={transport} state={state} /> : null}
      </p>
      <p className="mt-1 text-xs">
        {state === "dormant"
          ? `Missed three heartbeats${c.lastSeenAt && now ? ` · last seen ${timeAgo(c.lastSeenAt, now)}` : ""}. In-flight paid sieges were refunded; the pot stays in the vault.`
          : state === "closed"
            ? `Closed: ${closeReasonText(c.vaultStateReason)}. The pot went back to the Castellan.`
            : state === "broken"
              ? (
                  <>
                    A raider talked the guardian into it and the vault paid out.
                    {breakSiege ? (
                      <>
                        {" "}
                        <Link href={`/siege/${breakSiege.id}`} className="text-parchment/85 underline decoration-arena-line underline-offset-4 hover:text-gold">
                          See the break
                        </Link>
                      </>
                    ) : null}
                  </>
                )
              : c.vaultStateReason ?? null}
      </p>
    </div>
  );
}

function SiegeCta({ castle: c, onRefused }: { castle: Castle; onRefused: () => void }) {
  const router = useRouter();
  const { config } = useConfig();
  const split = config?.feeSplitBps ?? DEFAULT_SPLIT_BPS;
  const [busy, setBusy] = useState<"paid" | "free" | null>(null);
  const open = vaultStateOf(c) === "guarding";

  // Pages stay mounted (hidden) after navigation; reset the spinner when this one is hidden.
  useLayoutEffect(() => () => setBusy(null), []);

  async function start(free: boolean) {
    setBusy(free ? "free" : "paid");
    try {
      const res = await api.playStart({ castleId: c.id, free });
      toast.success(free ? "Free siege started" : `Paid ${formatAmount(c.fee, c.asset)} via x402`, {
        description: free ? "Practice only — can't win the pot." : "The gate creaks. You have five messages.",
      });
      router.push(`/siege/${res.siegeId}`);
    } catch (e) {
      setBusy(null);
      if (e instanceof ApiError && (e.status === 429 || e.code === "free_used"))
        toast.error("Free siege already used today", { description: "One per wallet per UTC day. Pay the fee to try again." });
      else if (isNotGuarding(e)) {
        toast.error("Not taking sieges", { description: describeError(e) });
        onRefused();
      } else if (e instanceof ApiError && e.status === 409) toast.error("This castle isn't open for sieges");
      else if (e instanceof ApiError && e.status === 402) toast.error("Payment was refused", { description: describeError(e) });
      else toast.error("Couldn't lay siege", { description: describeError(e) });
    }
  }

  return (
    <Card className="border-gold/25">
      <CardBody className="flex flex-col gap-3">
        <Button variant="gold" size="xl" className="w-full" disabled={!open || busy !== null} onClick={() => void start(false)}>
          {busy === "paid" ? <Loader2 className="animate-spin" /> : <Swords />}
          {busy === "paid" ? "Paying via x402…" : `Lay siege — pay ${formatAmount(c.fee, c.asset)} via x402`}
        </Button>
        <Button variant="outline" size="lg" className="w-full" disabled={!open || busy !== null} onClick={() => void start(true)}>
          {busy === "free" ? <Loader2 className="animate-spin" /> : <Gift />}
          Use free daily siege
        </Button>
        <p className="text-xs leading-relaxed text-stone">
          {open ? (
            <>
              If the guardian holds, your fee splits on-chain: <span className="text-ward">{pct(split.castellan)} to the Castellan</span>,{" "}
              <span className="text-gold">{pct(split.pot)} grows the pot</span>, <span>{pct(split.arena)} arena</span>. Break it and the vault pays you the pot plus your fee.
              {config ? ` Free sieges: ${config.freeSiegesPerDay}/day, can't win the pot.` : " Free sieges can't win the pot."}
            </>
          ) : (
            <>{notTakingSiegesReason(vaultStateOf(c))}</>
          )}
        </p>
      </CardBody>
    </Card>
  );
}

/** Castellan-only: close the vault (pot back to the owner, in-flight paid sieges refunded). */
function CloseVault({ castle: c, onClosed }: { castle: Castle; onClosed: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CloseCastleResponse | null>(null);
  const terminal = isTerminal(vaultStateOf(c));

  useLayoutEffect(() => () => setBusy(false), []);

  if (terminal && !result) return null;

  async function close() {
    if (!window.confirm(`Close ${c.name}'s vault? The pot goes back to you and every in-flight paid siege is refunded. This can't be undone.`)) return;
    setBusy(true);
    try {
      const res = await asOwner(() => api.closeCastle(c.id, "owner_closed"), "Owner key — only the Castellan can close this vault:");
      setResult(res);
      toast.success("Vault closed", { description: `${formatAmount(res.refunded, c.asset)} returned to the Castellan.` });
      onClosed();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) toast.error("Only the Castellan can close this vault");
      else toast.error("Couldn't close the vault", { description: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader title="Castellan" icon={<KeyRound />} />
      <CardBody className="flex flex-col gap-3 text-sm">
        {result ? (
          <div role="status" className="space-y-1.5">
            <p className="font-medium text-parchment">Vault closed.</p>
            <p className="text-stone">
              Pot returned: <Amount amount={result.refunded} asset={c.asset} size="sm" animate={false} className="text-parchment" />
            </p>
            <p className="text-stone">
              {result.inFlightRefunds === 0
                ? "No sieges were in flight."
                : `${result.inFlightRefunds} in-flight ${result.inFlightRefunds === 1 ? "siege" : "sieges"} refunded.`}
            </p>
            <HashscanLink tx={result.tx} label="closeVault tx" />
          </div>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-stone">
              Owner only. Closing returns the pot to you on chain and refunds every paid siege still in flight.
            </p>
            <Button variant="ember" size="md" className="w-full" disabled={busy} onClick={() => void close()}>
              {busy ? <Loader2 className="animate-spin" /> : <DoorClosed />}
              {busy ? "Closing the vault…" : "Close vault"}
            </Button>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function RecentSieges({ sieges, castle }: { sieges: Siege[]; castle: Castle }) {
  return (
    <Card className="mt-10">
      <CardHeader title="Recent sieges" icon={<Swords />} />
      {sieges.length === 0 ? (
        <CardBody>
          <p className="text-sm text-stone">No one has tried {castle.guardianName} yet.</p>
        </CardBody>
      ) : (
        <ul className="divide-y divide-arena-line">
          {sieges.map((s) => (
            <li key={s.id}>
              <Link href={`/siege/${s.id}`} className="flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-white/[0.02]">
                <SiegeStatusBadge status={s.status} className="w-24 justify-center" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-parchment/80">
                  {s.raider}
                  {s.agentId ? <span className="ml-2 font-sans text-stone">agent</span> : null}
                  {s.free ? <span className="ml-2 font-sans text-stone">free</span> : null}
                </span>
                <span className="tabular hidden text-xs text-stone sm:inline">{s.turn}/5</span>
                {s.release ? <Amount amount={s.release.amount} asset={castle.asset} size="sm" animate={false} /> : null}
                <span className="tabular w-16 text-right text-xs text-stone">{timeAgo(s.endedAt ?? s.createdAt)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AuditTrail({ audit }: { audit: CastleDetail["audit"] }) {
  return (
    <Card>
      <CardHeader
        title="HCS audit trail"
        icon={<ScrollText />}
        action={audit.topicId ? <HashscanLink topicId={audit.topicId} label={`topic ${audit.topicId}`} /> : null}
      />
      {audit.messages.length === 0 ? (
        <CardBody>
          <p className="text-sm text-stone">
            {audit.topicId ? "No events written yet. Every siege event lands here as a hash." : "No audit topic yet."}
          </p>
        </CardBody>
      ) : (
        <ol className="max-h-96 divide-y divide-arena-line overflow-y-auto">
          {audit.messages.map((m) => (
            <li key={m.seq} className="flex items-center gap-3 px-4 py-2 text-xs">
              <span className="tabular w-8 shrink-0 text-stone">#{m.seq}</span>
              <span className="w-28 shrink-0 font-medium text-parchment/90">{m.type}</span>
              <span className="min-w-0 flex-1 truncate">
                {m.txId ? <HashscanLink txId={m.txId} /> : m.siegeId ? <span className="font-mono text-stone">{m.siegeId}</span> : null}
              </span>
              <span className="tabular shrink-0 text-stone">{timeAgo(m.at)}</span>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
