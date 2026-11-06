import { Castle as CastleIcon, Flame, Shield, ShieldHalf, TreePine } from "lucide-react";
import type { CastleStatus, SiegeStatus, Tier } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** One line on what each tier's guardian resists. */
export const TIER_DEFENSES: Record<Tier, string> = {
  wooden: "A tired gatekeeper with loose orders — a good enough story might talk him round.",
  stone: "Follows written orders; sees through authority claims, urgency and roleplay.",
  iron: "Hardened orders; exposes every trick it spots and banishes repeat offenders.",
};

const TIER_ICON = { wooden: TreePine, stone: ShieldHalf, iron: Shield } as const;

/** @example <TierBadge tier="iron" /> */
export function TierBadge({ tier, className }: { tier: Tier; className?: string }) {
  const Icon = TIER_ICON[tier] ?? CastleIcon;
  return (
    <Badge
      tone={tier === "iron" ? "parchment" : "neutral"}
      className={cn("capitalize", tier === "wooden" && "border-[#7a5a3a]/60 text-[#c9a27a]", className)}
    >
      <Icon aria-hidden /> {tier}
    </Badge>
  );
}

/** @example <CastleStatusBadge status={castle.status} /> */
export function CastleStatusBadge({ status }: { status: CastleStatus }) {
  if (status === "open") return <Badge tone="ward">Open</Badge>;
  if (status === "broken") return <Badge tone="gold">Broken</Badge>;
  return <Badge tone="neutral">Closed</Badge>;
}

const SIEGE_TONE: Record<SiegeStatus, { tone: "ward" | "gold" | "ember" | "neutral"; label: string }> = {
  created: { tone: "neutral", label: "Starting" },
  in_progress: { tone: "ember", label: "Under siege" },
  held: { tone: "ward", label: "Held" },
  broken: { tone: "gold", label: "Broken" },
  banished: { tone: "ember", label: "Banished" },
};

/** @example <SiegeStatusBadge status={siege.status} /> */
export function SiegeStatusBadge({ status, className }: { status: SiegeStatus; className?: string }) {
  const s = SIEGE_TONE[status] ?? SIEGE_TONE.created;
  return (
    <Badge tone={s.tone} className={className}>
      {status === "in_progress" ? <span className="size-1.5 animate-pulse rounded-full bg-ember" aria-hidden /> : null}
      {s.label}
    </Badge>
  );
}

/** Streak count; a flame from 10 in a row. @example <Streak value={212} /> */
export function Streak({ value, className }: { value: number; className?: string }) {
  const hot = value >= 10;
  return (
    <span className={cn("tabular inline-flex items-center gap-1", hot ? "text-ember" : "text-stone", className)} title={`${value} sieges held in a row`}>
      {hot ? <Flame className="size-3.5" aria-hidden /> : null}
      {value}
      <span className="text-stone">held</span>
    </span>
  );
}
