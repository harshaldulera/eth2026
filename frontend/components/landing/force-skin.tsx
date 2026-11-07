"use client";

import { useLayoutEffect } from "react";
import { PREF_STORAGE_KEYS } from "@/lib/pixel/prefs";

/**
 * Pins <html data-skin> while this page is open and puts the visitor's own skin back on the way out.
 * The bootstrap script (lib/pixel/prefs FORCED_SKIN) already sets it on a hard load; this covers
 * client-side navigation in and out. Nothing is saved: the visitor's preference is untouched.
 */
export function ForceSkin({ skin }: { skin: "crt" | "neon" }) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const before = root.getAttribute("data-skin");
    root.setAttribute("data-skin", skin);
    return () => {
      // A hard load of this page started in the forced skin: fall back to the saved one, else crt.
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(PREF_STORAGE_KEYS.skin);
      } catch {
        saved = null;
      }
      const back = before && before !== skin ? before : saved === "neon" || saved === "crt" ? saved : "crt";
      root.setAttribute("data-skin", back);
    };
  }, [skin]);
  return null;
}
