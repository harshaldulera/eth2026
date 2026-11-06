import Link from "next/link";
import { Hourglass, KeyRound, Swords } from "lucide-react";
import type { Castle } from "@/lib/types";
import { HOSTED_PROTECTED_TOOL } from "@/lib/types";
import type { ArkivCastleMeta } from "@/lib/api/client";
import { vaultStateOf } from "@/lib/money/vault";
import { shortAccount } from "@/lib/money/format";
import { Amount } from "@/components/money/amount";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { Streak, TierBadge } from "./tier";
import { ProtectedTool, TransportBadge, VaultStateBadge } from "./vault-state";

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

/**
 * Board card for one castle; links to /castle/[id]. With `arkiv` (set when the board read the castle
 * from Arkiv) it shows who owns the listing and when the entity expires.
 *
 * @example <CastleCard castle={c} arkiv={c.arkiv} underSiege now={now} />
 */
export function CastleCard({
  castle: c,
  arkiv,
  underSiege = false,
  now = 0,
  href = `/castle/${c.id}`,
  className,
}: {
  castle: Castle;
  arkiv?: ArkivCastleMeta;
  underSiege?: boolean;
  now?: number;
  href?: string;
  className?: string;
}) {
  const state = vaultStateOf(c);
  const open = state === "guarding";
  const transport = c.transport ?? "hosted";
  const tool = c.protectedTool || HOSTED_PROTECTED_TOOL;
  const expires = untilText(arkiv?.expiresAtMs, now);
  return (
    <Link
      href={href}
      className={cn(
        "group relative flex flex-col rounded-2xl border border-arena-line bg-arena-panel/90 p-4 transition-[border-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-gold/40 hover:shadow-[0_18px_40px_-24px_rgb(245_196_81/0.45)]",
        !open && "opacity-75",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold text-parchment">{c.name}</h3>
          <p className="truncate text-sm text-stone">
            {c.guardianName} · <span className="text-parchment/75">{c.title}</span>
          </p>
        </div>
        <TierBadge tier={c.tier} />
      </div>

      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2">
        <TransportBadge transport={transport} />
        {transport === "sdk" || tool !== HOSTED_PROTECTED_TOOL ? <ProtectedTool tool={tool} /> : null}
        {underSiege ? (
          <Badge tone="ember" title="A raider is attacking this castle right now (a live siege entity on Arkiv)">
            <Swords aria-hidden /> Under siege
          </Badge>
        ) : null}
      </div>

      <div className="mt-4">
        <p className="text-[11px] tracking-[0.14em] text-stone uppercase">Pot</p>
        <Amount amount={c.pot} asset={c.asset} size="xl" />
      </div>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-arena-line pt-3 text-xs">
        <span className="text-stone">
          fee <Amount amount={c.fee} asset={c.asset} size="xs" animate={false} className="text-gold/90" />
        </span>
        <Streak value={c.streak} />
        <VaultStateBadge state={state} />
      </div>

      {arkiv ? (
        <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-stone">
          <span className="inline-flex min-w-0 items-center gap-1" title={`Listing owned by ${arkiv.castellan} on Arkiv. Only this wallet can delist it.`}>
            <KeyRound className="size-3 shrink-0 text-ward/80" aria-hidden />
            owned by <span className="truncate font-mono text-parchment/80">{shortAccount(arkiv.castellan)}</span>
          </span>
          {expires ? (
            <span className="inline-flex shrink-0 items-center gap-1" title="The Arkiv entity expires at the vault deadline; the castle then leaves the board on its own">
              <Hourglass className="size-3" aria-hidden />
              expires {expires}
            </span>
          ) : null}
        </div>
      ) : null}
    </Link>
  );
}
