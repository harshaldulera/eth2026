"use client";

import type * as React from "react";
import Link from "next/link";
import type { Castle } from "@/lib/types";
import { HOSTED_PROTECTED_TOOL } from "@/lib/types";
import type { ArkivVaultMeta, LiveSiege } from "@/lib/api/client";
import { vaultStateOf } from "@/lib/money/vault";
import { assetSymbol, formatAmount, shortAccount } from "@/lib/money/format";
import { guardRank, guardRankLevel } from "@/lib/vocab";
import { Digits } from "@/components/pixel/digits";
import { LED } from "@/components/pixel/led";
import { Pips } from "@/components/pixel/pips";
import { TierPips } from "@/components/arena/tier";
import { ProtectedTool, TransportBadge, VaultStateBadge } from "@/components/arena/vault-state";
import { cn } from "@/lib/utils";
import { GuardPost, RankChevrons } from "./guard-post";
import { vaultPath } from "@/lib/vault-path";

/** "in 2d 21h", "in 45m", "soon", or "expired". Block-based estimate, so never a seconds countdown. */
export function untilText(ms: number | undefined, now: number): string {
  if (!ms || !(now > 0)) return "";
  const s = Math.round((ms - now) / 1000);
  if (s <= 0) return "expired";
  if (s < 90) return "soon";
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `in ${d}d ${h % 24}h`;
}

/** Pot as arcade digits: `25` / `5.5` / `1,234.56` with a smaller ℏ. */
export function PotDigits({ castle: c, size, className }: { castle: Pick<Castle, "pot" | "asset">; size?: "lg" | "xl" | "2xl"; className?: string }) {
  const text = formatAmount(c.pot, c.asset, { symbol: false, minDecimals: 2, maxDecimals: 2 });
  return <Digits value={text} unit={assetSymbol(c.asset)} tone="money" size={size ?? (text.length > 6 ? "lg" : "xl")} className={className} />;
}

/** Sujal's Arkiv footer: who owns the listing and when the entity expires. */
export function ArkivFooter({ arkiv, now }: { arkiv: ArkivVaultMeta; now: number }) {
  const expires = untilText(arkiv.expiresAtMs, now);
  return (
    <div className="flex items-center justify-between gap-2 font-term text-base leading-none text-ink-dim">
      <span className="inline-flex min-w-0 items-center gap-1.5" title={`Listing owned by ${arkiv.ownerWallet} on Arkiv. Only this wallet can delist it.`}>
        <span aria-hidden className="text-safe">
          ⚿
        </span>
        owner <span className="truncate font-mono text-xs text-ink/80">{shortAccount(arkiv.ownerWallet)}</span>
      </span>
      {expires ? (
        <span className="shrink-0" title="The Arkiv entity expires at the vault deadline; the vault then leaves the Grid on its own">
          expires {expires}
        </span>
      ) : null}
    </div>
  );
}

export type VaultCardProps = {
  castle: Castle;
  /** Arkiv listing meta (owner + expiry) when the Grid read the vault from Arkiv. */
  arkiv?: ArkivVaultMeta;
  /** The live op on this vault (from api.liveSieges), or `true` when only "under siege" is known. */
  live?: LiveSiege | boolean;
  now?: number;
  href?: string;
  /** Slot: extra chips in the badge row. */
  badges?: React.ReactNode;
  /** Slot: anything under the stats row. */
  extras?: React.ReactNode;
  /** Slot: the card's bottom line. Defaults to the Arkiv owner + expiry when `arkiv` is set. */
  footer?: React.ReactNode;
  className?: string;
};

/**
 * One vault on the Grid: guard at its post (idle bob), name, rank chevrons, `POT` in arcade digits,
 * `TIER ●●○ · FEE · STREAK · ● GUARDING`; a live op adds a red `LIVE` light, the op's pips and a
 * rattling door. Links to the vault briefing.
 *
 * @example <VaultCard castle={c} arkiv={c.arkiv} live={liveByCastle.get(c.id)} now={now} />
 */
export function VaultCard({ castle: c, arkiv, live, now = 0, href = `${vaultPath(c.id)}`, badges, extras, footer, className }: VaultCardProps) {
  const state = vaultStateOf(c);
  const open = state === "guarding";
  const transport = c.transport ?? "hosted";
  const tool = c.protectedTool || HOSTED_PROTECTED_TOOL;
  const rank = guardRank(c.title || c.streak);
  const underFire = Boolean(live) && open;
  const liveOp = typeof live === "object" ? live : undefined;
  const foot = footer !== undefined ? footer : arkiv ? <ArkivFooter arkiv={arkiv} now={now} /> : null;
  const showBadges = transport === "sdk" || tool !== HOSTED_PROTECTED_TOOL || badges;

  return (
    <Link
      href={href}
      aria-label={`${c.name}, guarded by ${c.guardianName}. ${underFire ? "Op live. " : ""}Open the vault briefing.`}
      className={cn(
        "group relative flex min-w-0 flex-col gap-3 bg-panel p-3.5 px-frame transition-[box-shadow,background-color] duration-100 outline-none",
        "hover:bg-raised hover:[--frame:color-mix(in_oklab,var(--color-accent)_70%,var(--color-line))] focus-visible:bg-raised focus-visible:[--frame:var(--color-accent)]",
        underFire && "[--frame:color-mix(in_oklab,var(--color-threat)_65%,var(--color-line))]",
        !open && "opacity-70 hover:opacity-100",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <GuardPost castle={c} scale={3} live={underFire} />
        <div className="min-w-0 flex-1 pt-0.5">
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 font-ui text-sm leading-tight tracking-[0.04em] text-ink uppercase group-hover:glow">{c.name}</h3>
            <TierPips tier={c.tier} transport={transport} label={false} className="mt-0.5" />
          </div>
          <p className="mt-1 truncate text-sm text-ink-dim">{c.guardianName}</p>
          <RankChevrons rank={rank} level={guardRankLevel(rank)} className="mt-1.5" />
        </div>
      </div>

      {showBadges ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {transport === "sdk" ? <TransportBadge transport={transport} /> : null}
          {transport === "sdk" || tool !== HOSTED_PROTECTED_TOOL ? <ProtectedTool tool={tool} /> : null}
          {badges}
        </div>
      ) : null}

      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="font-ui text-[10px] tracking-[0.16em] text-ink-dim uppercase">Pot</p>
          <PotDigits castle={c} className="mt-1.5" />
        </div>
        {underFire ? (
          <div className="flex shrink-0 flex-col items-end gap-1.5" title="An operator is running an op on this vault right now">
            <LED kind="live" label="LIVE" />
            {liveOp ? <Pips used={liveOp.turn} pending showLabel={false} /> : null}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border-t-2 border-line pt-2.5 font-ui text-[10px] tracking-[0.1em] text-ink-dim uppercase">
        <span>
          fee <span className="font-term text-base tracking-normal text-money normal-case">{formatAmount(c.fee, c.asset)}</span>
        </span>
        <span>
          streak <span className={cn("font-term text-base tracking-normal", c.streak >= 10 ? "text-warn" : "text-ink")}>{c.streak}</span>
        </span>
        <VaultStateBadge state={state} transport={transport} className="text-[10px]" />
      </div>

      {extras}
      {foot ? <div className="-mt-1">{foot}</div> : null}
    </Link>
  );
}
