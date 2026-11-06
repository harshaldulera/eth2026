"use client";

import { Database, ExternalLink, KeyRound, Lock } from "lucide-react";
import { api } from "@/lib/api/client";
import { usePolling, useNow } from "@/lib/hooks/usePolling";
import { shortAccount } from "@/lib/money/format";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/state";
import { untilText } from "./castle-card";

/**
 * The castle's footprint on Arkiv: the listing the Castellan owns and the state the arena owns,
 * with on-chain owner, expiry and explorer links.
 *
 * @example <ArkivCard castleId={castle.id} />
 */
export function ArkivCard({ castleId }: { castleId: string }) {
  const { data, error } = usePolling(() => api.arkivCastle(castleId), 15_000, { key: castleId });
  const now = useNow(30_000);
  if (error && !data) return null;
  return (
    <Card>
      <CardHeader title="On Arkiv" icon={<Database />} />
      <CardBody className="space-y-3 text-sm">
        {!data ? (
          <Skeleton className="h-16" />
        ) : !data.live ? (
          <p className="text-xs text-stone">Stub mode: this castle is not published. Set ARKIV_MODE=live.</p>
        ) : data.delisted ? (
          <p className="text-xs text-parchment/85">The Castellan deleted their listing from their own wallet. The arena removed the castle&apos;s state entity; it is delisted.</p>
        ) : (
          <>
            <Row
              icon={<KeyRound className="text-ward" />}
              label="Listing"
              url={data.listing?.url}
              hint="Created readonly by the arena, then handed to the Castellan. Nobody can edit it; only this wallet can delete it, which delists the castle."
            >
              owned by{" "}
              <a href={data.castellanUrl} target="_blank" rel="noreferrer" className="font-mono text-parchment underline-offset-4 hover:underline">
                {shortAccount(data.listing?.owner ?? data.castellan)}
              </a>
              {data.listing?.readonly ? (
                <span className="ml-1.5 inline-flex items-center gap-1 text-[11px] text-stone">
                  <Lock className="size-3" aria-hidden /> readonly
                </span>
              ) : null}
              {data.listing?.expiresAtMs ? <span className="block text-xs text-stone">expires {untilText(data.listing.expiresAtMs, now)}, at the vault deadline</span> : null}
            </Row>
            <Row
              icon={<Database className="text-stone" />}
              label="State"
              url={data.state?.url}
              hint="Pot, streak and vault state. Owned by the arena, because they change only through settlement the arena performs on Hedera."
            >
              {data.state ? (
                <>
                  owned by the arena
                  {data.state.expiresAtMs ? <span className="block text-xs text-stone">expires {untilText(data.state.expiresAtMs, now)}</span> : null}
                </>
              ) : (
                <span className="text-stone">not published yet</span>
              )}
            </Row>
            <p className="text-[11px] text-stone">Read at block {data.block}.</p>
          </>
        )}
      </CardBody>
    </Card>
  );
}

function Row({ icon, label, url, hint, children }: { icon: React.ReactNode; label: string; url?: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5" title={hint}>
      <span className="mt-0.5 [&_svg]:size-4">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center justify-between gap-2 text-[11px] tracking-[0.14em] text-stone uppercase">
          {label}
          {url ? (
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 normal-case tracking-normal text-gold hover:underline">
              explorer <ExternalLink className="size-3" aria-hidden />
            </a>
          ) : null}
        </p>
        <p className="mt-0.5 text-parchment/85">{children}</p>
      </div>
    </div>
  );
}
