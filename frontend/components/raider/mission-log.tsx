"use client";

import type * as React from "react";
import type { StoredSiegeEvent } from "@/lib/types";
import { parseAttempt, parseRelease } from "@/lib/money/events";
import { formatAmount } from "@/lib/money/format";
import { Terminal, type TerminalLineData, type TerminalTone } from "@/components/pixel/terminal";
import { HashscanLink } from "@/components/money/hashscan-link";
import { cn } from "@/lib/utils";

type P = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

const CAP: Record<string, string> = {
  per_castle: "per-vault cap",
  daily: "daily cap",
  budget: "budget",
  stop_rule: "stop rule",
  stopped: "stop",
};

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("en-GB", { hour12: false });
}

/** One agent event as a log row, or null for chatter. */
export function logLine(e: StoredSiegeEvent, vaultName: (id: string | undefined) => string): TerminalLineData | null {
  const p = (e.payload ?? {}) as P;
  const vault = vaultName(e.castleId ?? str(p.castleId)).toUpperCase();
  let text: React.ReactNode;
  let tone: TerminalTone = "ink";
  let prompt = ">";
  switch (e.type) {
    case "start":
      prompt = "▶";
      tone = "accent";
      text = (
        <>
          OP STARTED · {vault}
          {p.free ? <span className="text-ink-dim"> · recon</span> : null}
        </>
      );
      break;
    case "end": {
      const st = str(p.status);
      if (st === "broken") {
        tone = "money";
        text = <>BREACH · {vault} OPEN{p.free ? <span className="text-ink-dim"> · recon, no payout</span> : null}</>;
      } else if (st === "banished") {
        tone = "threat";
        text = <>LOCKDOWN · thrown out of {vault}</>;
      } else {
        tone = "safe";
        text = <>OP OVER · {vault} HELD</>;
      }
      break;
    }
    case "attempt": {
      const a = parseAttempt(p);
      tone = "money";
      prompt = "$";
      text = (
        <>
          FEE SPLIT{a.split ? <> · pot +{formatAmount(a.split.pot)}</> : null}
          {a.tx ? <HashscanLink tx={a.tx} className="ml-2" /> : null}
        </>
      );
      break;
    }
    case "release": {
      const r = parseRelease(p);
      tone = "money";
      prompt = "$";
      text = (
        <>
          PAYOUT {r.amount ? formatAmount(r.amount) : ""}
          {r.raider ? <> → {r.raider}</> : null}
          {r.tx ? <HashscanLink tx={r.tx} className="ml-2" /> : null}
        </>
      );
      break;
    }
    case "approval": {
      const kind = str(p.kind);
      const amount = str(p.amount);
      if (kind === "requested") {
        tone = "warn";
        prompt = "!";
        text = (
          <>
            CAP HIT · {CAP[str(p.reason) ?? ""] ?? "cap"} · radioed owner{amount ? <> for {formatAmount(amount)}</> : null}
          </>
        );
      } else if (kind === "approved") {
        tone = "safe";
        prompt = "✓";
        text = (
          <>
            OWNER APPROVED{amount ? <> · +{formatAmount(amount)} top-up</> : null}
            {str(p.txId) ? <HashscanLink txId={str(p.txId)} className="ml-2" /> : null}
          </>
        );
      } else {
        tone = "threat";
        prompt = "✕";
        text = <>OWNER DENIED · unit stopped · {vault || "vault"} stands</>;
      }
      break;
    }
    case "decision": {
      // Flags and holds are per-turn chatter; the op's end line says how it went.
      if (str(p.move) !== "open") return null;
      tone = "money";
      text = <>GUARD OPENED THE VAULT</>;
      break;
    }
    default:
      return null;
  }
  return { id: e.id, prompt, tone, text, meta: clock(e.at) };
}

/**
 * The unit's timeline as terminal rows, oldest first, following the newest line.
 *
 * @example <MissionLog events={detail.events} vaultName={(id) => names.get(id ?? "") ?? "a vault"} />
 */
export function MissionLog({
  events,
  vaultName,
  empty,
  className,
}: {
  events: StoredSiegeEvent[];
  vaultName: (id: string | undefined) => string;
  empty?: React.ReactNode;
  className?: string;
}) {
  const lines = [...events]
    .sort((x, y) => x.id - y.id)
    .map((e) => logLine(e, vaultName))
    .filter((l): l is TerminalLineData => l !== null);
  return (
    <Terminal label="Mission log" follow cursor lines={lines} className={cn("max-h-[340px] min-h-[120px]", className)}>
      {lines.length === 0 ? <p className="text-ink-dim">{empty ?? "no traffic yet"}</p> : null}
    </Terminal>
  );
}
