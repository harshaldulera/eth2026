import Link from "next/link";
import type { Castle } from "@/lib/types";
import { Amount } from "@/components/money/amount";
import { cn } from "@/lib/utils";
import { CastleStatusBadge, Streak, TierBadge } from "./tier";

/**
 * Board card for one castle; links to /castle/[id].
 *
 * @example <CastleCard castle={c} />
 */
export function CastleCard({ castle: c, href = `/castle/${c.id}`, className }: { castle: Castle; href?: string; className?: string }) {
  const open = c.status === "open";
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

      <div className="mt-5">
        <p className="text-[11px] tracking-[0.14em] text-stone uppercase">Pot</p>
        <Amount amount={c.pot} asset={c.asset} size="xl" />
      </div>

      <div className="mt-4 flex items-center justify-between gap-2 border-t border-arena-line pt-3 text-xs">
        <span className="text-stone">
          fee <Amount amount={c.fee} asset={c.asset} size="xs" animate={false} className="text-gold/90" />
        </span>
        <Streak value={c.streak} />
        <CastleStatusBadge status={c.status} />
      </div>
    </Link>
  );
}
