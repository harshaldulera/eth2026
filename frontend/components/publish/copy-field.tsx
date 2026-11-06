"use client";

import { useEffect, useRef, useState } from "react";
import { PUBLISH } from "@/lib/vocab";
import { cn } from "@/lib/utils";
import { PixelButton } from "@/components/pixel/button";
import { playCue } from "@/components/pixel/sfx-link";

/**
 * A labelled read-only value with a COPY key (share link, owner key, guard key).
 *
 * @example <CopyField label="OWNER KEY" value={ownerKey} tone="warn" />
 */
export function CopyField({ label, value, tone, className }: { label: string; value: string; tone?: "warn" | "money"; className?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    const finish = () => {
      setDone(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setDone(false), 1500);
    };
    void navigator.clipboard?.writeText(value).then(finish, () => undefined);
    playCue("ui_blip");
  };
  return (
    <div className={cn("flex items-center gap-2 border-2 bg-bg px-2.5 py-1.5", tone === "warn" ? "border-warn" : tone === "money" ? "border-money/60" : "border-line", className)}>
      <div className="min-w-0 flex-1">
        <p className={cn("font-ui text-[11px] tracking-[0.12em] uppercase", tone === "warn" ? "text-warn" : "text-ink-dim")}>{label}</p>
        <p className="font-term text-[20px] leading-[1.15] break-all text-ink select-all">{value}</p>
      </div>
      <PixelButton size="sm" variant={tone === "warn" ? "outline" : "outline"} onClick={copy}>
        {done ? PUBLISH.copied : PUBLISH.copy}
      </PixelButton>
    </div>
  );
}
