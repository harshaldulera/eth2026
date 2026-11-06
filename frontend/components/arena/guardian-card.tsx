"use client";

import type { Castle, TransportKind } from "@/lib/types";
import { HOSTED_PROTECTED_TOOL } from "@/lib/types";
import { Amount } from "@/components/money/amount";
import { Sprite } from "@/components/pixel/sprite";
import { GuardSprite, voiceTag } from "@/components/scene/guard-sprite";
import { guardRank, guardRankLevel, tierLabel, tierLevel } from "@/lib/vocab";
import { cn } from "@/lib/utils";
import { Streak, TIER_DEFENSES } from "./tier";
import { ProtectedTool, TransportBadge } from "./vault-state";

/**
 * The guard's dossier: portrait in a small monitor, name, rank chevrons, voice, tier, transport,
 * the protected tool and the vault pot.
 *
 * `transport` overrides the castle's (an op keeps the transport it started on).
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
  const rank = guardRank(c.title || c.streak);
  const lvl = tierLevel(c.tier, transport);
  return (
    <div className={cn("bg-panel p-3 px-frame", className)}>
      <div className="flex items-center gap-3">
        <div className="grid size-[60px] shrink-0 place-items-center bg-bg shadow-[inset_0_0_0_2px_var(--color-line)]">
          <GuardSprite guard={{ ...c, transport }} scale={3} label={c.guardianName} />
        </div>
        <div className="min-w-0">
          <p className="truncate font-ui text-sm text-ink uppercase">{c.guardianName}</p>
          <p className="mt-1 flex items-center gap-1.5 font-ui text-[10px] tracking-[0.12em] text-ink-dim">
            <Sprite name={`rank.${guardRankLevel(rank)}`} scale={1} />
            {rank} · {voiceTag({ ...c, transport })}
          </p>
          <p className="mt-0.5 truncate text-xs text-ink-dim">{c.name}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="font-ui text-[11px] tracking-[0.1em] text-ink-dim">
          {tierLabel(c.tier, transport)} <span className="text-accent">{"●".repeat(lvl) + "○".repeat(3 - lvl)}</span>
        </span>
        <TransportBadge transport={transport} />
        <Streak value={c.streak} className="text-xs" />
      </div>
      <ProtectedTool tool={c.protectedTool || HOSTED_PROTECTED_TOOL} className="mt-2" />
      {!compact ? <p className="mt-3 text-sm leading-relaxed text-ink-dim">{TIER_DEFENSES[c.tier]}</p> : null}
      <div className="mt-3 bg-money/[0.06] p-3 shadow-[inset_0_0_0_2px_color-mix(in_oklab,var(--color-money)_20%,transparent)]">
        <p className="font-ui text-[11px] tracking-[0.14em] text-ink-dim uppercase">Vault pot</p>
        <Amount amount={c.pot} asset={c.asset} size="xl" />
        <p className="mt-1 text-xs text-ink-dim">
          Op fee <Amount amount={c.fee} asset={c.asset} size="xs" animate={false} />
        </p>
      </div>
    </div>
  );
}
