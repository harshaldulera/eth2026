"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { PUBLISH } from "@/lib/vocab";
import { PixelButton, pixelButtonVariants } from "@/components/pixel/button";
import { PixelPanel } from "@/components/pixel/panel";
import { Stamp } from "@/components/pixel/stamp";
import { playCue } from "@/components/pixel/sfx-link";
import { QrCode } from "@/components/raider/qr-code";
import { cn } from "@/lib/utils";
import { CopyField } from "./copy-field";
import { DryRun } from "./dry-run";

const noSub = () => () => {};
/** The page origin, "" on the server and during hydration. */
export function useOrigin(): string {
  return useSyncExternalStore(
    noSub,
    () => window.location.origin,
    () => "",
  );
}

export type LiveCardProps = {
  castleId: string;
  /** Path like /castle/<id>. */
  shareUrl: string;
  /** Shown once; null once the owner said they saved it. */
  ownerKey: string | null;
  onKeySaved?: () => void;
  onAnother?: () => void;
  className?: string;
};

/**
 * YOUR VAULT IS LIVE: stamp, share link + QR, the owner key (once), RUN A DRY OP and OPEN VAULT PAGE.
 * Plays `ui_confirm` when it lands.
 *
 * @example <LiveCard castleId={id} shareUrl="/castle/abc" ownerKey={key} />
 */
export function LiveCard({ castleId, shareUrl, ownerKey, onKeySaved, onAnother, className }: LiveCardProps) {
  const origin = useOrigin();
  const [dry, setDry] = useState(false);
  const link = `${origin}${shareUrl}`;

  useEffect(() => {
    playCue("ui_confirm");
  }, []);

  return (
    <div className={cn("space-y-4", className)}>
      <PixelPanel tone="safe" className="flex flex-col items-center gap-8 px-6 py-10 text-center sm:py-12">
        <Stamp kind="hold" size="xl" tilt={-4} className="max-w-full text-lg leading-snug whitespace-normal sm:text-3xl">
          {PUBLISH.liveStamp}
        </Stamp>
        <p className="max-w-md text-[15px] leading-relaxed text-ink-dim">{PUBLISH.liveBody}</p>
      </PixelPanel>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <PixelPanel title={PUBLISH.shareLink} tone="money" bodyClassName="flex flex-col gap-3 p-3">
          <CopyField label={PUBLISH.shareLink} value={link} tone="money" />
          {origin ? <QrCode value={link} size={132} className="mx-auto shrink-0" /> : null}
        </PixelPanel>

        {ownerKey ? (
          <PixelPanel title={PUBLISH.ownerKey} tone="warn" bodyClassName="space-y-3 p-3 md:w-80">
            <CopyField label={PUBLISH.ownerKey} value={ownerKey} tone="warn" />
            <p className="text-[12px] leading-snug text-warn">{PUBLISH.ownerKeyWarn}</p>
            <PixelButton size="sm" variant="outline" onClick={onKeySaved}>
              {PUBLISH.ownerKeySaved}
            </PixelButton>
          </PixelPanel>
        ) : (
          <PixelPanel title={PUBLISH.ownerKey} tone="ghost" bodyClassName="p-3 md:w-80">
            <p className="text-[12px] leading-snug text-ink-dim">{PUBLISH.ownerKeyHidden}</p>
          </PixelPanel>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <PixelButton variant="money" size="lg" pressed={dry} onClick={() => setDry((d) => !d)}>
          {dry ? PUBLISH.dryOpOpen : PUBLISH.dryOp}
        </PixelButton>
        <Link href={`/castle/${castleId}`} onClick={() => playCue("ui_blip")} className={pixelButtonVariants({ variant: "safe", size: "lg" })}>
          {PUBLISH.openVault}
        </Link>
        {onAnother ? (
          <PixelButton variant="ghost" size="sm" onClick={onAnother}>
            {PUBLISH.publishAnother}
          </PixelButton>
        ) : null}
      </div>

      {dry ? <DryRun castleId={castleId} /> : null}
    </div>
  );
}
