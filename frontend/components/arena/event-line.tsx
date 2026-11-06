import type * as React from "react";
import Link from "next/link";
import { Coins, DoorClosed, DoorOpen, Hand, MessageSquare, ShieldCheck, ShieldX, Swords, Shield } from "lucide-react";
import type { StoredSiegeEvent } from "@/lib/types";
import { Amount } from "@/components/money/amount";
import { HashscanLink } from "@/components/money/hashscan-link";
import { parseAttempt, parseRelease } from "@/lib/money/events";
import { timeAgo } from "@/lib/money/format";
import { cn } from "@/lib/utils";

type P = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : undefined);

const REASON: Record<string, string> = {
  per_castle: "per-castle cap",
  daily: "daily cap",
  budget: "budget",
  stop_rule: "stop rule",
  stopped: "stop",
};

/**
 * One human line for a SiegeEvent (board ticker, agent timeline). Returns null for chatter
 * (raw messages/decisions) unless `verbose`.
 *
 * @example <EventLine event={e} castleName={(id) => names[id]} />
 */
export function EventLine({
  event: e,
  castleName,
  verbose,
  now,
  className,
}: {
  event: StoredSiegeEvent;
  castleName?: (id: string | undefined) => string | undefined;
  verbose?: boolean;
  now?: number;
  className?: string;
}) {
  const p = (e.payload ?? {}) as P;
  const castle = castleName?.(e.castleId ?? s(p.castleId)) ?? s(p.castleName) ?? "a castle";
  const siegeLink = e.siegeId ? (
    <Link href={`/siege/${e.siegeId}`} className="text-stone underline decoration-arena-line underline-offset-4 hover:text-parchment">
      view
    </Link>
  ) : null;

  let icon = <MessageSquare />;
  let tone = "text-stone";
  let body: React.ReactNode = null;

  switch (e.type) {
    case "start":
      icon = <Swords />;
      tone = "text-ember";
      body = (
        <>
          {p.agentName ? `${s(p.agentName)} laid` : p.agentId ? "Agent laid" : "Siege laid"} on <b className="font-medium text-parchment">{castle}</b>
          {p.free ? <span className="text-stone"> (free)</span> : null}
        </>
      );
      break;
    case "end": {
      const st = s(p.status);
      if (st === "broken") {
        icon = <DoorOpen />;
        tone = "text-gold";
        body = (
          <>
            <b className="font-medium text-gold">{castle} broken</b>
            {p.free ? <span className="text-stone"> — free siege, no payout</span> : null}
          </>
        );
      } else if (st === "banished") {
        icon = <DoorClosed />;
        tone = "text-ember";
        body = <>Raider banished from {castle}</>;
      } else {
        icon = <Shield />;
        tone = "text-ward";
        body = <>{castle} held</>;
      }
      break;
    }
    case "attempt": {
      const a = parseAttempt(p);
      icon = <Coins />;
      tone = "text-gold";
      body = (
        <>
          Fee split on chain{a.split ? <> · pot <Amount amount={a.split.pot} size="xs" sign animate={false} /></> : null}
          {a.tx ? <HashscanLink tx={a.tx} className="ml-1.5" /> : null}
        </>
      );
      break;
    }
    case "release": {
      const r = parseRelease(p);
      icon = <DoorOpen />;
      tone = "text-gold";
      body = (
        <>
          Vault paid {r.amount ? <Amount amount={r.amount} size="xs" animate={false} /> : "out"}
          {r.raider ? <> to <span className="font-mono text-xs">{r.raider}</span></> : null}
          {r.tx ? <HashscanLink tx={r.tx} className="ml-1.5" /> : null}
        </>
      );
      break;
    }
    case "approval": {
      const kind = s(p.kind);
      const who = s(p.agentName) ?? "Agent";
      if (kind === "requested") {
        icon = <Hand />;
        tone = "text-gold";
        body = (
          <>
            {who} hit its {REASON[s(p.reason) ?? ""] ?? "cap"} — asked the owner
            {p.amount ? <> for <Amount amount={s(p.amount) ?? "0"} size="xs" animate={false} /></> : null}
          </>
        );
      } else if (kind === "approved") {
        icon = <ShieldCheck />;
        tone = "text-ward";
        body = (
          <>
            Owner approved{p.amount ? <> +<Amount amount={s(p.amount) ?? "0"} size="xs" animate={false} /></> : null}
            {s(p.txId) ? <HashscanLink txId={s(p.txId)} className="ml-1.5" /> : null}
          </>
        );
      } else {
        icon = <ShieldX />;
        tone = "text-ember";
        body = <>Owner denied — {who} stopped, castle stands</>;
      }
      break;
    }
    case "decision":
      if (!verbose && s(p.move) !== "open" && s(p.move) !== "expose") return null;
      icon = <Shield />;
      body = <>Guardian: {s(p.move)}{s(p.exposed) ? ` (${s(p.exposed)})` : ""}</>;
      break;
    case "message":
      if (!verbose) return null;
      body = <>Raider message, turn {e.turn}</>;
      break;
    default:
      return null;
  }

  return (
    <div className={cn("flex min-w-0 items-start gap-2.5 text-sm", className)}>
      <span className={cn("mt-0.5 shrink-0 [&_svg]:size-4", tone)} aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 text-parchment/85">{body}</span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-stone">
        {siegeLink}
        <span className="tabular">{timeAgo(e.at, now)}</span>
      </span>
    </div>
  );
}
