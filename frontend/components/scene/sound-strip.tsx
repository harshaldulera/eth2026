"use client";

import { useState } from "react";
import { Volume2, X } from "lucide-react";
import { useSfx } from "@/lib/sfx/useSfx";
import { BUTTONS } from "@/lib/vocab";
import { cn } from "@/lib/utils";

/**
 * `TAP TO POWER ON SOUND`: the op room's one prompt for audio (browsers only allow sound after a
 * gesture). Hidden once sound is on, or after ✕. Every cue has a visual twin, so silence loses
 * nothing.
 */
export function SoundStrip({ className }: { className?: string }) {
  const { unlocked, muted, unlock, mute, play } = useSfx();
  const [dismissed, setDismissed] = useState(false);
  if (dismissed || (unlocked && !muted)) return null;
  return (
    <div className={cn("flex items-stretch bg-raised px-frame [--frame:color-mix(in_oklab,var(--color-accent)_45%,var(--color-line))]", className)}>
      <button
        type="button"
        onClick={async () => {
          await unlock();
          mute(false);
          play("power_on");
        }}
        className="flex min-h-10 flex-1 items-center justify-center gap-2 px-3 font-ui text-xs tracking-[0.14em] text-accent uppercase hover:brightness-125"
      >
        <Volume2 className="size-4 animate-blink" aria-hidden />
        {BUTTONS.tapPowerOn}
        <span className="hidden font-term text-lg tracking-normal text-ink-dim normal-case sm:inline">· M toggles</span>
      </button>
      <button type="button" onClick={() => setDismissed(true)} aria-label="Dismiss" className="grid w-10 place-items-center text-ink-dim hover:text-ink">
        <X className="size-4" />
      </button>
    </div>
  );
}
