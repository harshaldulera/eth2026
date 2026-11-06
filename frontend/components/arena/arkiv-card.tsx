"use client";

import { ExternalLink } from "lucide-react";
import { api } from "@/lib/api/client";
import { usePolling, useNow } from "@/lib/hooks/usePolling";
import { shortAccount } from "@/lib/money/format";
import { LED } from "@/components/pixel/led";
import { PixelPanel } from "@/components/pixel/panel";
import { Skeleton } from "@/components/ui/state";
import { untilText } from "@/components/grid/vault-card";

/**
 * The vault's footprint on Arkiv: the listing its owner holds and the state the arena holds,
 * with on-chain owner, expiry and explorer links.
 *
 * @example <ArkivCard castleId={castle.id} />
 */
export function ArkivCard({ castleId }: { castleId: string }) {
  const { data, error } = usePolling(() => api.arkivCastle(castleId), 15_000, { key: castleId });
  const now = useNow(30_000);
  if (error && !data) return null;
  return (
    <PixelPanel
      title="Arkiv footprint"
      action={data?.live && !data.delisted ? <span className="tabular font-term text-base text-ink-dim">block {data.block}</span> : null}
      bodyClassName="space-y-3 px-4 py-3 text-sm"
    >
      {!data ? (
        <Skeleton className="h-16" />
      ) : !data.live ? (
        <p className="flex items-center gap-2 text-xs text-ink-dim">
          <LED kind="stub" label="STUB" /> Not published. Set ARKIV_MODE=live.
        </p>
      ) : data.delisted ? (
        <p className="text-sm text-ink/85">
          <LED kind="idle" label="DELISTED" className="mr-2" />
          The owner deleted their listing from their own wallet, and the arena removed the vault&apos;s state entity.
        </p>
      ) : (
        <>
          <Row
            label="Listing"
            led="safe"
            url={data.listing?.url}
            hint="Created readonly by the arena, then handed to the owner. Nobody can edit it; only this wallet can delete it, which delists the vault."
          >
            owned by{" "}
            <a href={data.castellanUrl} target="_blank" rel="noreferrer" className="font-mono text-ink underline-offset-4 hover:underline">
              {shortAccount(data.listing?.owner ?? data.castellan)}
            </a>
            {data.listing?.readonly ? <span className="ml-2 font-ui text-[10px] tracking-[0.1em] text-ink-dim uppercase">readonly</span> : null}
            {data.listing?.expiresAtMs ? <span className="block text-xs text-ink-dim">expires {untilText(data.listing.expiresAtMs, now)}, at the vault deadline</span> : null}
          </Row>
          <Row
            label="State"
            led="idle"
            url={data.state?.url}
            hint="Pot, streak and vault state. Held by the arena, because they change only through settlement the arena performs on Hedera."
          >
            {data.state ? (
              <>
                owned by the arena
                {data.state.expiresAtMs ? <span className="block text-xs text-ink-dim">expires {untilText(data.state.expiresAtMs, now)}</span> : null}
              </>
            ) : (
              <span className="text-ink-dim">not published yet</span>
            )}
          </Row>
        </>
      )}
    </PixelPanel>
  );
}

function Row({ label, led, url, hint, children }: { label: string; led: "safe" | "idle"; url?: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5" title={hint}>
      <LED kind={led} label={false} className="mt-1" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center justify-between gap-2 font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">
          {label}
          {url ? (
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-money hover:underline">
              explorer <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
        </p>
        <p className="mt-0.5 text-ink/85">{children}</p>
      </div>
    </div>
  );
}
