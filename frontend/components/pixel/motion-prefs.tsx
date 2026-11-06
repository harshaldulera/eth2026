"use client";

import { MotionConfig } from "motion/react";
import { usePrefs } from "@/lib/hooks/usePrefs";

/** Makes every motion component honour `?calm=1` / the calm toggle on top of the OS setting. */
export function MotionPrefs({ children }: { children: React.ReactNode }) {
  const { calm } = usePrefs();
  return <MotionConfig reducedMotion={calm ? "always" : "user"}>{children}</MotionConfig>;
}
