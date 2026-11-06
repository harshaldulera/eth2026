import type { Castle } from "@/lib/types";
import type { ArkivVaultMeta } from "@/lib/api/client";
import { VaultCard } from "@/components/grid/vault-card";

/** Kept for existing imports; the card lives in components/grid/vault-card.tsx. */
export { untilText, VaultCard } from "@/components/grid/vault-card";

/**
 * Grid card for one vault (Part 1 name). Same props as before; renders VaultCard. With `arkiv`
 * (set when the Grid read the vault from Arkiv) it shows who owns the listing and when the entity
 * expires; `underSiege` lights the LIVE light.
 *
 * @example <CastleCard castle={c} arkiv={c.arkiv} underSiege now={now} />
 */
export function CastleCard({
  castle,
  arkiv,
  underSiege = false,
  now = 0,
  href,
  className,
}: {
  castle: Castle;
  arkiv?: ArkivVaultMeta;
  underSiege?: boolean;
  now?: number;
  href?: string;
  className?: string;
}) {
  return <VaultCard castle={castle} arkiv={arkiv} live={underSiege} now={now} href={href} className={className} />;
}
