"use client";

import { useEffect } from "react";
import { getPrefs, onPrefChange, setPref } from "@/lib/pixel/prefs";
import { playCue, unlockSfx } from "./sfx-link";

function editable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
}

/**
 * Mount point for the sound engine (once, in the root layout). Renders nothing.
 * - Unlocks audio on the first pointerdown / keydown (browsers block sound before a gesture).
 * - `M` toggles mute anywhere except while typing (the engine follows the `muted` pref).
 * - Unmuting plays `power_on`, the audible twin of the toggle.
 */
export function SfxBoot() {
  useEffect(() => {
    const offPref = onPrefChange((key, p) => {
      if (key === "muted" && !p.muted) playCue("power_on");
    });
    let unlocked = false;
    const unlock = () => {
      if (unlocked) return;
      unlocked = true;
      unlockSfx();
      window.removeEventListener("pointerdown", unlock, true);
    };
    const onKey = (e: KeyboardEvent) => {
      unlock();
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || editable(e.target)) return;
      if (e.key === "m" || e.key === "M") setPref("muted", !getPrefs().muted);
    };
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", onKey);
    return () => {
      offPref();
      window.removeEventListener("pointerdown", unlock, true);
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  return null;
}
