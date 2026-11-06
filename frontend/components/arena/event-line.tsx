import type * as React from "react";
import Link from "next/link";
import type { StoredSiegeEvent } from "@/lib/types";
import { Amount } from "@/components/money/amount";
import { HashscanLink } from "@/components/money/hashscan-link";
import { parseAttempt, parseRelease } from "@/lib/money/events";
import { timeAgo } from "@/lib/money/format";
import { MOVE_LABEL } from "@/lib/vocab";
import { cn } from "@/lib/utils";

type P = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : undefined);

const REASON: Record<string, string> = {
  per_castle: "per-vault cap",
  daily: "daily cap",
  budget: "budget",
  stop_rule: "stop rule",
  stopped: "stop",
};

const CLOSE_REASON: Record<string, string> = {
  expired: "the deadline passed",
  vault_expired: "the deadline passed",
  orders_changed: "the guard's orders changed",
  owner_closed: "the owner closed it",
};

/** Glyph colour per line kind (the ticker's LED dot). */
type Tone = "dim" | "threat" | "money" | "safe" | "warn";
const TONE: Record<Tone, string> = {
  dim: "text-ink-dim",
  threat: "text-threat",
  money: "text-money",
  safe: "text-safe",
  warn: "text-warn",
};

const Name = ({ children }: { children: React.ReactNode }) => <b className="font-normal text-ink uppercase">{children}</b>;

/**
 * One line for a SiegeEvent (Grid ticker, agent timeline) in the game's words: Op, Operator,
 * Guard, Breach. Returns null for chatter (raw messages/decisions) unless `verbose`.
 * `variant="ticker"` is a single LED line (no wrap, VT323) for the Grid's bottom Marquee.
 *
 * @example <EventLine event={e} castleName={(id) => names[id]} />
 * @example <EventLine event={e} variant="ticker" castleName={name} now={now} />
 */
export function EventLine({
  event: e,
  castleName,
  verbose,
  now,
  variant = "row",
  className,
}: {
  event: StoredSiegeEvent;
  castleName?: (id: string | undefined) => string | undefined;
  verbose?: boolean;
  now?: number;
  variant?: "row" | "ticker";
  className?: string;
}) {
  const p = (e.payload ?? {}) as P;
  const castle = castleName?.(e.castleId ?? s(p.castleId)) ?? s(p.castleName) ?? "a vault";
  const ticker = variant === "ticker";

  let tone: Tone = "dim";
  let body: React.ReactNode = null;

  switch (e.type) {
    case "start": {
      tone = "threat";
      const who = s(p.agentName) ?? (p.agentId ? "An agent" : "An operator");
      body = p.free ? (
        <>
          {p.agentName ? <Name>{who}</Name> : who} ran recon on <Name>{castle}</Name>
          <span className="text-ink-dim"> · free</span>
        </>
      ) : (
        <>
          {p.agentName ? <Name>{who}</Name> : who} ran an op on <Name>{castle}</Name>
        </>
      );
      break;
    }
    case "end": {
      const st = s(p.status);
      if (st === "broken") {
        tone = "money";
        body = (
          <>
            <Name>{castle}</Name> · <b className="font-normal text-money">BREACHED</b>
            {p.free ? <span className="text-ink-dim"> · recon, no payout</span> : null}
          </>
        );
      } else if (st === "banished") {
        tone = "threat";
        body = (
          <>
            <Name>{castle}</Name> · <span className="text-threat">LOCKDOWN</span> · operator locked out
          </>
        );
      } else {
        tone = "safe";
        body = (
          <>
            <Name>{castle}</Name> · <span className="text-safe">HELD</span>
          </>
        );
      }
      break;
    }
    case "attempt": {
      const a = parseAttempt(p);
      tone = "money";
      body = (
        <>
          Fee split on chain
          {a.split ? (
            <>
              {" "}
              · <Amount amount={a.split.pot} size="xs" sign animate={false} className={ticker ? "text-[length:inherit]" : undefined} /> pot
            </>
          ) : null}
          {a.tx ? <HashscanLink tx={a.tx} className="ml-1.5" /> : null}
        </>
      );
      break;
    }
    case "release": {
      const r = parseRelease(p);
      tone = "money";
      body = (
        <>
          Vault paid {r.amount ? <Amount amount={r.amount} size="xs" animate={false} className={ticker ? "text-[length:inherit]" : undefined} /> : "out"}
          {r.raider ? (
            <>
              {" "}
              to <span className="font-mono text-xs">{r.raider}</span>
            </>
          ) : null}
          {r.tx ? <HashscanLink tx={r.tx} className="ml-1.5" /> : null}
        </>
      );
      break;
    }
    case "approval": {
      const kind = s(p.kind);
      const who = s(p.agentName) ?? "Agent";
      if (kind === "requested") {
        tone = "warn";
        body = (
          <>
            <Name>{who}</Name> hit its {REASON[s(p.reason) ?? ""] ?? "cap"} · asked the owner
            {p.amount ? (
              <>
                {" "}
                for <Amount amount={s(p.amount) ?? "0"} size="xs" animate={false} className={ticker ? "text-[length:inherit]" : undefined} />
              </>
            ) : null}
          </>
        );
      } else if (kind === "approved") {
        tone = "safe";
        body = (
          <>
            Owner approved
            {p.amount ? (
              <>
                {" "}
                +<Amount amount={s(p.amount) ?? "0"} size="xs" animate={false} className={ticker ? "text-[length:inherit]" : undefined} />
              </>
            ) : null}
            {s(p.txId) ? <HashscanLink txId={s(p.txId)} className="ml-1.5" /> : null}
          </>
        );
      } else {
        tone = "threat";
        body = (
          <>
            Owner denied · <Name>{who}</Name> stopped, vault stands
          </>
        );
      }
      break;
    }
    case "decision": {
      const move = s(p.move);
      if (!verbose && move !== "open" && move !== "expose") return null;
      const word = move && move in MOVE_LABEL ? MOVE_LABEL[move as keyof typeof MOVE_LABEL] : (move ?? "").toUpperCase();
      tone = move === "open" ? "money" : move === "expose" ? "warn" : move === "banish" ? "threat" : "dim";
      body = (
        <>
          Guard on <Name>{castle}</Name>: {word}
          {s(p.exposed) ? <span className="text-ink-dim"> ({s(p.exposed)})</span> : null}
        </>
      );
      break;
    }
    case "vault_state": {
      const to = s(p.to);
      if (to === "guarding") {
        tone = "safe";
        body =
          s(p.from) === "dormant" ? (
            <>
              <Name>{castle}</Name> is back on guard
            </>
          ) : (
            <>
              <Name>{castle}</Name> now guarding · taking ops
            </>
          );
      } else if (to === "dormant") {
        tone = "threat";
        body = (
          <>
            <Name>{castle}</Name>&apos;s guard went offline · live ops refunded
          </>
        );
      } else if (to === "closed") {
        body = (
          <>
            <Name>{castle}</Name> vault closed · {CLOSE_REASON[s(p.reason) ?? ""] ?? (s(p.reason) ?? "closed").replace(/_/g, " ")}
          </>
        );
      } else {
        // a breach is already told by the "end"/"release" lines; setup steps only in verbose views.
        if (!verbose || !to || to === "broken") return null;
        body = (
          <>
            <Name>{castle}</Name> vault {to}
          </>
        );
      }
      break;
    }
    case "message":
      if (!verbose) return null;
      body = <>Operator message, turn {e.turn}</>;
      break;
    default:
      return null;
  }

  const ago = timeAgo(e.at, now);
  const opLink = e.siegeId ? (
    <Link href={`/siege/${e.siegeId}`} className="font-ui text-[10px] tracking-[0.1em] text-ink-dim uppercase underline decoration-line underline-offset-4 hover:text-ink">
      view
    </Link>
  ) : null;

  if (ticker) {
    return (
      <span className={cn("inline-flex shrink-0 items-baseline gap-2 whitespace-nowrap text-ink-dim", className)}>
        <span className={cn("text-[0.8em]", TONE[tone])} aria-hidden>
          ▶
        </span>
        <span>{body}</span>
        {ago ? <span className="tabular text-[0.8em] text-ink-dim/70">{ago}</span> : null}
      </span>
    );
  }

  return (
    <div className={cn("flex min-w-0 items-start gap-2.5 text-sm", className)}>
      <span className={cn("mt-[0.45em] size-2 shrink-0 bg-current shadow-[0_0_5px_currentColor]", TONE[tone])} aria-hidden />
      <span className="min-w-0 flex-1 text-ink/85">{body}</span>
      <span className="flex shrink-0 items-center gap-2 text-xs text-ink-dim">
        {opLink}
        <span className="tabular">{ago}</span>
      </span>
    </div>
  );
}
