"use client";

import { motion } from "motion/react";
import { Sprite } from "@/components/pixel/sprite";
import { useCalmMotion } from "@/lib/hooks/usePrefs";
import { assetSymbol, toNumber } from "@/lib/money/format";
import type { Amount, Asset } from "@/lib/types";
import { cn } from "@/lib/utils";

const MAX_COINS = 28;

// Deterministic burst (golden-angle spread): render stays pure and every replay looks the same.
const BURST = Array.from({ length: MAX_COINS }, (_, i) => {
  const angle = -Math.PI / 2 + ((i * 2.399963) % (Math.PI * 1.1)) - Math.PI * 0.55;
  const v = 110 + ((i * 37) % 80);
  return {
    x: Math.cos(angle) * v,
    y: Math.sin(angle) * v,
    fall: 120 + ((i * 53) % 90),
    delay: (i % 12) * 0.05,
    frame: i % 4,
  };
});

export type CoinFountainProps = {
  /** Number of coins (≤ 28). */
  count?: number;
  /** Coin sprite scale (8 px art). */
  scale?: number;
  /** Seconds before the first coin. */
  delay?: number;
  className?: string;
};

/**
 * A burst of spinning pixel coins out of a point (the open vault). Mount it to fire once. None
 * under reduced motion (the amount just fades in).
 *
 * @example <div className="relative"><CoinFountain count={12} /></div>
 */
export function CoinFountain({ count = 20, scale = 3, delay = 0, className }: CoinFountainProps) {
  const calm = useCalmMotion();
  if (calm) return null;
  return (
    <div aria-hidden className={cn("pointer-events-none absolute top-1/2 left-1/2 z-10", className)}>
      {BURST.slice(0, Math.min(MAX_COINS, count)).map((c, i) => (
        <motion.span
          key={i}
          className="absolute block"
          style={{ marginLeft: -4 * scale, marginTop: -4 * scale }}
          initial={{ x: 0, y: 0, opacity: 0 }}
          animate={{ x: [0, c.x, c.x * 1.25], y: [0, c.y, c.y + c.fall], opacity: [0, 1, 1, 0] }}
          transition={{
            default: { duration: 1.3, delay: delay + c.delay, ease: "easeOut", times: [0, 0.4, 1] },
            opacity: { duration: 1.3, delay: delay + c.delay, ease: "linear", times: [0, 0.08, 0.8, 1] },
          }}
        >
          <Sprite name="coin" scale={scale} animate={{ fps: 12 }} frame={c.frame} />
        </motion.span>
      ))}
    </div>
  );
}

/** "5.50 ℏ": money copy always shows at least two decimals. */
export function money(amount: Amount | bigint | number | undefined, asset?: Asset, maxDecimals = 4): string {
  if (amount === undefined) return "—";
  const n = toNumber(amount, asset);
  const s = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: Math.max(2, maxDecimals) });
  return `${s} ${assetSymbol(asset)}`;
}
