"use client";

import { useState } from "react";
import { api, type ZgUsageResponse } from "@/lib/api/client";
import { usePolling } from "@/lib/hooks/usePolling";
import { ZG } from "@/lib/vocab";
import { cn } from "@/lib/utils";
import { Digits } from "@/components/pixel/digits";

export type ZgCreditsProps = ({ castleId: string; agentId?: never } | { agentId: string; castleId?: never }) & {
  /** Poll interval (ms). Default 5 s: the balance visibly drops during an op. */
  intervalMs?: number;
  /** Show "0G NOT CONNECTED" instead of nothing when the guard/unit has no key. */
  showDisconnected?: boolean;
  /** "hero": big balance digits plus the drop since the page opened (owner panel); default: one line. */
  variant?: "line" | "hero";
  className?: string;
};

/** micro-USD decimal string → "$0.04". */
export function usdFromMicro(micro: string): string {
  let n = 0;
  try {
    n = Number(BigInt(micro)) / 1e6;
  } catch {}
  return `$${n.toFixed(n > 0 && n < 0.01 ? 4 : 2)}`;
}

/** The credits line text: "0G CREDITS 24.988 · 3 calls · $0.04" (balance only with an mk- key). */
export function creditsLine(u: Pick<ZgUsageResponse, "balance" | "calls" | "costUsdMicro">): string {
  return [u.balance !== undefined ? `${ZG.creditsLabel} ${u.balance}` : ZG.creditsLabel, ZG.calls(u.calls), usdFromMicro(u.costUsdMicro)].join(" · ");
}

/**
 * Live "0G CREDITS <balance> · N calls · $X.XX" for a guard (castleId) or a unit (agentId), polling
 * GET /api/zg/usage. Renders nothing until connected (or `showDisconnected`).
 *
 * @example <ZgCredits castleId={castle.id} />
 */
export function ZgCredits({ castleId, agentId, intervalMs = 5000, showDisconnected, variant = "line", className }: ZgCreditsProps) {
  const id = castleId ?? agentId ?? "";
  const { data } = usePolling(() => api.zgUsage(castleId ? { castleId } : { agentId: agentId ?? "" }), intervalMs, { key: `${castleId ? "c" : "a"}:${id}`, enabled: Boolean(id) });
  // The first balance seen on this page: the hero readout shows how far it dropped since.
  const bal = data?.connected && data.balance !== undefined ? Number(data.balance) : null;
  const [base, setBase] = useState<number | null>(null);
  if (base === null && bal !== null && Number.isFinite(bal)) setBase(bal);
  if (!data) return null;
  if (!data.connected) {
    return showDisconnected ? <p className={cn("font-ui text-[11px] tracking-[0.1em] text-ink-dim uppercase", className)}>{ZG.notConnected}</p> : null;
  }
  if (variant === "hero") {
    const drop = base !== null && bal !== null ? base - bal : 0;
    return (
      <div className={cn("space-y-1", className)} aria-live="polite" data-testid="zg-credits-hero">
        <p className="font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">{ZG.creditsLabel}</p>
        {data.balance !== undefined ? <Digits value={data.balance} size="lg" tone="money" /> : null}
        <p className="font-ui text-[11px] tracking-[0.1em] text-ink-dim uppercase tabular">
          {[ZG.calls(data.calls), usdFromMicro(data.costUsdMicro)].join(" · ")}
        </p>
        {data.balance !== undefined ? (
          <p className={cn("font-ui text-[11px] tracking-[0.08em] uppercase tabular", drop > 0 ? "text-threat" : "text-ink-dim")}>
            {drop > 0 ? ZG.droppedSince(drop.toFixed(3)) : ZG.steadySince}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <p className={cn("font-ui text-[11px] tracking-[0.1em] text-money uppercase tabular", className)} aria-live="polite">
      {creditsLine(data)}
    </p>
  );
}
