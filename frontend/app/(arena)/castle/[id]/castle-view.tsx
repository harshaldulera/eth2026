"use client";

import { useLayoutEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Gift, Loader2, ScrollText, Swords } from "lucide-react";
import type { Castle, Siege } from "@/lib/types";
import { ApiError, api, describeError, type CastleDetail } from "@/lib/api/client";
import { usePolling } from "@/lib/hooks/usePolling";
import { useConfig } from "@/lib/hooks/useConfig";
import { formatAmount, timeAgo } from "@/lib/money/format";
import { Amount } from "@/components/money/amount";
import { HashscanLink } from "@/components/money/hashscan-link";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState, ErrorState, Loading } from "@/components/ui/state";
import { CastleStatusBadge, SiegeStatusBadge, Streak, TIER_DEFENSES, TierBadge } from "@/components/arena/tier";

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
  return <CastleDetailView detail={data} />;
}

function CastleDetailView({ detail }: { detail: CastleDetail }) {
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
            <CastleStatusBadge status={c.status} />
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">{c.name}</h1>
          <p className="mt-1 text-lg text-parchment/80">
            Guarded by {c.guardianName}, <span className="text-stone">{c.title}</span>
          </p>
          <p className="mt-3 max-w-xl text-sm text-stone">{TIER_DEFENSES[c.tier]}</p>

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
          <SiegeCta castle={c} />
          <AuditTrail audit={audit} />
        </aside>
      </div>
    </div>
  );
}

function SiegeCta({ castle: c }: { castle: Castle }) {
  const router = useRouter();
  const { config } = useConfig();
  const split = config?.feeSplitBps ?? DEFAULT_SPLIT_BPS;
  const [busy, setBusy] = useState<"paid" | "free" | null>(null);
  const open = c.status === "open";

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
      else if (e instanceof ApiError && e.status === 409) toast.error("This castle isn't open for sieges");
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
            <>This castle is {c.status}. No new sieges.</>
          )}
        </p>
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
              <span className="w-16 shrink-0 font-medium text-parchment/90">{m.type}</span>
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
