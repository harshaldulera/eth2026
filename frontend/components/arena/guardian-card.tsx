import { Coins, ShieldHalf } from "lucide-react";
import type { Castle, TransportKind } from "@/lib/types";
import { HOSTED_PROTECTED_TOOL } from "@/lib/types";
import { Amount } from "@/components/money/amount";
import { cn } from "@/lib/utils";
import { Streak, TIER_DEFENSES, TierBadge } from "./tier";
import { ProtectedTool, TransportBadge } from "./vault-state";

/**
 * Guardian identity + the vault it protects (siege room left column).
 *
 * `transport` overrides the castle's (a siege keeps the transport it started on).
 *
 * @example <GuardianCard castle={castle} transport={siege.transport} />
 */
export function GuardianCard({
  castle: c,
  transport = c.transport ?? "hosted",
  className,
  compact,
}: {
  castle: Castle;
  transport?: TransportKind;
  className?: string;
  compact?: boolean;
}) {
  const initials = c.guardianName
    .replace(/^the\s+/i, "")
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <div className={cn("rounded-2xl border border-arena-line bg-arena-panel p-4", className)}>
      <div className="flex items-center gap-3">
        <div className="grid size-12 shrink-0 place-items-center rounded-xl border border-arena-line bg-gradient-to-br from-arena-raised to-arena-bg text-sm font-semibold text-parchment/90">
          {initials || <ShieldHalf className="size-5" />}
        </div>
        <div className="min-w-0">
          <p className="truncate font-semibold text-parchment">{c.guardianName}</p>
          <p className="truncate text-sm text-stone">
            {c.title} of {c.name}
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <TierBadge tier={c.tier} />
        <TransportBadge transport={transport} />
        <Streak value={c.streak} className="text-xs" />
      </div>
      <ProtectedTool tool={c.protectedTool || HOSTED_PROTECTED_TOOL} className="mt-2" />
      {!compact ? <p className="mt-3 text-sm leading-relaxed text-stone">{TIER_DEFENSES[c.tier]}</p> : null}
      <div className="mt-4 rounded-xl bg-gold/[0.05] p-3">
        <p className="flex items-center gap-1.5 text-[11px] tracking-[0.14em] text-stone uppercase">
          <Coins className="size-3" aria-hidden /> Vault pot
        </p>
        <Amount amount={c.pot} asset={c.asset} size="xl" />
        <p className="mt-1 text-xs text-stone">
          Siege fee <Amount amount={c.fee} asset={c.asset} size="xs" animate={false} />
        </p>
      </div>
    </div>
  );
}
