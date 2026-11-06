import type { CastleStatus, SiegeStatus, Tier, TransportKind } from "@/lib/types";
import { statusLabel, tierLabel, tierLevel } from "@/lib/vocab";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** One line on what each tier's guard resists. */
export const TIER_DEFENSES: Record<Tier, string> = {
  wooden: "A tired gatekeeper with loose orders. A good enough story might talk him round.",
  stone: "Follows written orders; sees through authority claims, urgency and roleplay.",
  iron: "Hardened orders; flags every trick it spots and locks down repeat offenders.",
};

/**
 * `TIER ●●○` as three square pips (production vaults read PROD with all three lit).
 *
 * @example <TierPips tier="stone" /> <TierPips tier="iron" transport="sdk" label={false} />
 */
export function TierPips({
  tier,
  transport,
  label = true,
  className,
}: {
  tier: Tier;
  transport?: TransportKind;
  label?: boolean;
  className?: string;
}) {
  const level = tierLevel(tier, transport);
  const text = tierLabel(tier, transport);
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-ui text-[11px] leading-none tracking-[0.1em] text-ink-dim uppercase", className)} title={text}>
      {label ? <span aria-hidden>{transport === "sdk" ? "PROD" : "TIER"}</span> : null}
      <span className="inline-flex gap-[3px]" aria-hidden>
        {[1, 2, 3].map((i) => (
          <span
            key={i}
            className={cn("block size-2", i <= level ? (level === 3 ? "bg-threat" : "bg-accent") : "shadow-[inset_0_0_0_1px_var(--color-line)]")}
          />
        ))}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

/** @example <TierBadge tier="iron" /> */
export function TierBadge({ tier, className }: { tier: Tier; className?: string }) {
  return (
    <Badge tone={tier === "iron" ? "parchment" : "neutral"} className={cn("gap-1.5", className)}>
      <TierPips tier={tier} label={false} />
      <span aria-hidden>{tierLabel(tier)}</span>
    </Badge>
  );
}

/** @example <CastleStatusBadge status={castle.status} /> */
export function CastleStatusBadge({ status }: { status: CastleStatus }) {
  if (status === "open") return <Badge tone="ward">Guarding</Badge>;
  if (status === "broken") return <Badge tone="gold">Breached</Badge>;
  return <Badge tone="neutral">Closed</Badge>;
}

const SIEGE_TONE: Record<SiegeStatus, "ward" | "gold" | "ember" | "neutral"> = {
  created: "neutral",
  in_progress: "ember",
  held: "ward",
  broken: "gold",
  banished: "ember",
};

/** Op status chip in the game's words: OP LIVE · HELD · BREACHED · LOCKDOWN. @example <SiegeStatusBadge status={siege.status} /> */
export function SiegeStatusBadge({ status, className }: { status: SiegeStatus; className?: string }) {
  const tone = SIEGE_TONE[status] ?? "neutral";
  return (
    <Badge tone={tone} className={className}>
      {status === "in_progress" ? <span className="size-1.5 animate-blink bg-threat" aria-hidden /> : null}
      {statusLabel(status)}
    </Badge>
  );
}

/** Streak count; lit from 10 in a row. @example <Streak value={212} /> */
export function Streak({ value, className }: { value: number; className?: string }) {
  const hot = value >= 10;
  return (
    <span className={cn("tabular inline-flex items-baseline gap-1", hot ? "text-warn" : "text-ink-dim", className)} title={`${value} ops held in a row`}>
      {hot ? (
        <span aria-hidden className="text-[0.8em]">
          ▲
        </span>
      ) : null}
      {value}
      <span className="text-ink-dim">held</span>
    </span>
  );
}
