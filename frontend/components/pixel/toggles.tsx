"use client";

import { Monitor, Sparkles, Volume2, VolumeX, Wind, ScanLine } from "lucide-react";
import { usePrefs } from "@/lib/hooks/usePrefs";
import { cn } from "@/lib/utils";
import { PixelButton } from "./button";

type ToggleProps = { className?: string; /** Icon-only square (HUD) vs a labelled row (settings). */ compact?: boolean };

function Row({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="font-ui text-[11px] tracking-[0.1em] text-ink-dim uppercase">{label}</span>
      <span className="flex items-center gap-2">
        <span className="sr-only">{value}</span>
        {children}
      </span>
    </div>
  );
}

/** CRT phosphor ↔ neon 16-bit. */
export function SkinToggle({ className, compact }: ToggleProps) {
  const { skin, set } = usePrefs();
  const next = skin === "crt" ? "neon" : "crt";
  const btn = (
    <PixelButton
      size={compact ? "icon" : "sm"}
      variant="outline"
      className={className}
      onClick={() => set("skin", next)}
      aria-label={`Skin: ${skin === "crt" ? "CRT" : "neon"}. Switch to ${next === "crt" ? "CRT" : "neon"}`}
      title="Switch skin"
    >
      {skin === "crt" ? <Monitor aria-hidden /> : <Sparkles aria-hidden />}
      {compact ? null : skin === "crt" ? "CRT" : "NEON"}
    </PixelButton>
  );
  return compact ? btn : <Row label="Skin" value={skin}>{btn}</Row>;
}

/** Scanline overlay on/off. */
export function CrtToggle({ className, compact }: ToggleProps) {
  const { crt, set } = usePrefs();
  const btn = (
    <PixelButton
      size={compact ? "icon" : "sm"}
      variant={crt ? "outline" : "ghost"}
      pressed={crt}
      className={className}
      onClick={() => set("crt", !crt)}
      aria-label="Scanlines"
      title="Scanlines"
    >
      <ScanLine aria-hidden />
      {compact ? null : crt ? "ON" : "OFF"}
    </PixelButton>
  );
  return compact ? btn : <Row label="Scanlines" value={crt ? "on" : "off"}>{btn}</Row>;
}

/** Sound on/off (`M` does the same). */
export function MuteToggle({ className, compact = true }: ToggleProps) {
  const { muted, set } = usePrefs();
  const btn = (
    <PixelButton
      size={compact ? "icon" : "sm"}
      variant="ghost"
      cue={muted ? null : "ui_blip"}
      className={cn(muted ? "text-ink-dim" : "text-accent", className)}
      onClick={() => set("muted", !muted)}
      aria-label={muted ? "Sound off. Turn sound on (M)" : "Sound on. Mute (M)"}
      title={muted ? "Sound off (M)" : "Sound on (M)"}
    >
      {muted ? <VolumeX aria-hidden /> : <Volume2 aria-hidden />}
      {compact ? null : muted ? "OFF" : "ON"}
    </PixelButton>
  );
  return compact ? btn : <Row label="Sound" value={muted ? "off" : "on"}>{btn}</Row>;
}

/** Calm: stills flicker, stamps' slam and every decorative animation (same as `?calm=1`). */
export function CalmToggle({ className, compact }: ToggleProps) {
  const { calm, set } = usePrefs();
  const btn = (
    <PixelButton
      size={compact ? "icon" : "sm"}
      variant={calm ? "outline" : "ghost"}
      pressed={calm}
      className={className}
      onClick={() => set("calm", !calm)}
      aria-label="Calm motion"
      title="Calm motion"
    >
      <Wind aria-hidden />
      {compact ? null : calm ? "ON" : "OFF"}
    </PixelButton>
  );
  return compact ? btn : <Row label="Calm motion" value={calm ? "on" : "off"}>{btn}</Row>;
}
