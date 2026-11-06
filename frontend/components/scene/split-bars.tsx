"use client";

import { useEffect, useState } from "react";
import { Sprite } from "@/components/pixel/sprite";
import { Digits } from "@/components/pixel/digits";
import { HashscanLink } from "@/components/money/hashscan-link";
import { useCalmMotion } from "@/lib/hooks/usePrefs";
import { HBAR, toUnits } from "@/lib/money/format";
import { MONEY } from "@/lib/vocab";
import type { Amount, Asset, FeeSplit, TxRef } from "@/lib/types";
import { cn } from "@/lib/utils";
import { money } from "./coin-fountain";

export type SplitBarsProps = {
  /** The fee that was split. */
  fee: Amount;
  /** On-chain split from AttemptRecorded; omit while settling. */
  split?: FeeSplit;
  /** Pot after this op; the pot ticker counts up to it. */
  newPot?: Amount;
  /** The recordAttempt tx. */
  tx?: TxRef;
  asset?: Asset;
  title?: string;
  ownerLabel?: string;
  /**
   * 0–1 through the sort, driven by the scene (settle beat) so a replay can scrub it. Omit to play
   * once on mount.
   */
  progress?: number;
  /** Wall: bigger type. */
  size?: "md" | "wall";
  className?: string;
};

const COINS = 12;
/** Coins finish sorting at this fraction of the settle beat (1.1 s of 1.5 s). */
const SORT_END = 0.73;
const SELF_MS = 1500;

type Lane = { key: "owner" | "pot" | "arena"; label: string; amount: bigint; tone: string; fill: string };

function laneCoins(lanes: Lane[], total: bigint): number[] {
  if (total <= BigInt(0)) return lanes.map(() => 0);
  const raw = lanes.map((l) => (Number(l.amount) / Number(total)) * COINS);
  const n = raw.map((r, i) => (lanes[i].amount > BigInt(0) ? Math.max(1, Math.round(r)) : 0));
  // keep the sum at COINS, taking from / giving to the biggest lane
  const diff = COINS - n.reduce((a, b) => a + b, 0);
  const big = n.indexOf(Math.max(...n));
  n[big] = Math.max(1, n[big] + diff);
  return n;
}

const part = (amount: bigint, f: number) => (amount * BigInt(Math.round(Math.min(1, Math.max(0, f)) * 1000))) / BigInt(1000);

/** 0 → 1 once after mount (rAF), or 1 at once under reduced motion. */
function useMountProgress(enabled: boolean, ms: number): number {
  const calm = useCalmMotion();
  const [p, setP] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let raf = 0;
    const t0 = performance.now();
    const loop = (now: number) => {
      const v = calm ? 1 : Math.min(1, (now - t0) / ms);
      setP(v);
      if (v < 1) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [enabled, ms, calm]);
  return p;
}

/**
 * The fee rail: the fee drops as coins from a hopper into three lanes OWNER / POT / ARENA, each
 * lane's amount counts up as its coins land, then the pot ticker and `AttemptRecorded ↗`.
 *
 * @example <SplitBars fee={fee} split={split} newPot={newPot} tx={siege.attempt} progress={frame.coins.progress} />
 */
export function SplitBars({ fee, split, newPot, tx, asset = HBAR, title = "Fee rail", ownerLabel = "Owner", progress, size = "md", className }: SplitBarsProps) {
  const self = useMountProgress(progress === undefined && Boolean(split), SELF_MS);
  const p = progress ?? self;
  const wall = size === "wall";

  const lanes: Lane[] = split
    ? [
        { key: "owner", label: ownerLabel, amount: toUnits(split.castellan), tone: "text-safe", fill: "bg-safe" },
        { key: "pot", label: "Pot", amount: toUnits(split.pot), tone: "text-money", fill: "bg-money" },
        { key: "arena", label: "Arena", amount: toUnits(split.arena), tone: "text-ink-dim", fill: "bg-ink-dim" },
      ]
    : [];
  const total = lanes.reduce((a, l) => a + l.amount, BigInt(0));
  const counts = laneCoins(lanes, total);
  // coin i → (lane, slot); coins alternate lanes so all three fill together
  const order: { lane: number; slot: number }[] = [];
  const used = counts.map(() => 0);
  for (let i = 0; order.length < counts.reduce((a, b) => a + b, 0); i++) {
    const lane = i % 3;
    if (used[lane] < counts[lane]) order.push({ lane, slot: used[lane]++ });
  }
  const step = SORT_END / Math.max(1, order.length + 2);
  const coinT = (i: number) => Math.min(1, Math.max(0, (p - i * step) / (step * 3)));
  const landed = counts.map((_, li) => order.filter((o, i) => o.lane === li && coinT(i) >= 1).length);
  const laneDone = counts.map((c, li) => (c ? landed[li] / c : 1));

  const potCut = split ? toUnits(split.pot) : BigInt(0);
  const potAfter = newPot !== undefined ? toUnits(newPot) : undefined;
  const potShown = potAfter !== undefined ? potAfter - potCut + part(potCut, laneDone[1] ?? 0) : undefined;

  return (
    <div className={cn("bg-panel px-frame", className)}>
      <div className="flex min-h-9 items-center justify-between gap-3 border-b-2 border-line bg-raised/70 px-3 py-1.5">
        <h3 className="flex items-center gap-2 font-ui text-xs tracking-[0.12em] text-ink-dim uppercase">
          <span className="size-2 bg-money" aria-hidden />
          {title}
        </h3>
        <span className="font-ui text-[11px] tracking-[0.08em] text-ink-dim uppercase">
          fee <span className="text-money">{money(fee, asset)}</span>
        </span>
      </div>

      {!split ? (
        <div className="space-y-2 p-3" aria-live="polite">
          <p className="flex items-center gap-2 font-term text-xl leading-none text-money">
            <span className="animate-blink" aria-hidden>
              ▮
            </span>
            {MONEY.settling}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {["OWNER", "POT", "ARENA"].map((l) => (
              <div key={l} className="shimmer h-16" aria-hidden />
            ))}
          </div>
        </div>
      ) : (
        <div className="p-3" aria-live="polite">
          {/* the rail: hopper on top, three lanes below */}
          <div className={cn("relative", wall ? "h-[200px]" : "h-[104px]")} aria-hidden>
            <div className="absolute top-0 left-1/2 flex h-5 w-20 -translate-x-1/2 items-end justify-center border-x-2 border-b-2 border-line bg-bg/60">
              <span className="mb-0.5 font-ui text-[9px] tracking-[0.1em] text-ink-dim">FEE</span>
            </div>
            {[0, 1, 2].map((li) => (
              <div
                key={li}
                className={cn("absolute bottom-0 border-x-2 border-b-2 border-line bg-bg/50", wall ? "h-[120px]" : "h-[64px]")}
                style={{ left: `calc(${li * 33.333}% + 4px)`, width: "calc(33.333% - 8px)" }}
              />
            ))}
            {order.map((o, i) => {
              const t = coinT(i);
              if (t <= 0) return null;
              const laneX = o.lane * 33.333 + 16.667;
              const col = o.slot % 4;
              const row = Math.floor(o.slot / 4);
              const coinPx = wall ? 24 : 16;
              const endX = `calc(${laneX}% + ${(col - 1.5) * (coinPx + 2)}px)`;
              const startX = "50%";
              const endY = (wall ? 200 : 104) - 6 - (row + 1) * (coinPx + 1);
              const startY = 4;
              // fall with a little arc, landing hard (steps feel)
              const e = t * t;
              const left = `calc(${startX} + (${endX} - ${startX}) * ${Math.min(1, t * 1.15).toFixed(3)})`;
              const top = startY + (endY - startY) * e - Math.sin(Math.PI * t) * 10;
              return (
                <span key={i} className="absolute" style={{ left, top, marginLeft: -coinPx / 2 }}>
                  <Sprite name="coin" scale={wall ? 3 : 2} frame={t >= 1 ? 0 : Math.floor(t * 8) % 4} />
                </span>
              );
            })}
          </div>

          <div className="mt-2 grid grid-cols-3 gap-2 text-center">
            {lanes.map((l, li) => (
              <div key={l.key} className="min-w-0">
                <p className={cn("font-ui tracking-[0.12em] uppercase", l.tone, wall ? "text-xl" : "text-[11px]")}>{l.label}</p>
                <p className={cn("tabular font-pixel leading-tight", l.tone, wall ? "text-3xl" : "text-[14px]")}>
                  +{money(part(l.amount, laneDone[li]), asset, laneDone[li] < 1 ? 2 : 4).replace(/ .*/, "")}
                  <span className="text-[0.7em]"> ℏ</span>
                </p>
              </div>
            ))}
          </div>

          {potShown !== undefined ? (
            <div className="mt-3 flex items-center justify-between gap-3 bg-money/[0.07] px-3 py-2 shadow-[inset_0_0_0_2px_color-mix(in_oklab,var(--color-money)_25%,transparent)]">
              <span className="font-ui text-[11px] tracking-[0.12em] text-ink uppercase">Pot now</span>
              <Digits value={money(potShown, asset, (laneDone[1] ?? 1) < 1 ? 2 : 4).replace(/ .*/, "")} unit="ℏ" tone="money" size={wall ? "xl" : "md"} />
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t-2 border-line pt-2">
            <p className="font-term text-lg leading-tight text-ink-dim">
              {MONEY.feeSplit(money(split.castellan, asset).replace(/ .*/, ""), money(split.pot, asset).replace(/ .*/, ""), money(split.arena, asset).replace(/ .*/, ""))}
            </p>
            {tx ? <HashscanLink tx={tx} label="AttemptRecorded ↗" className="text-xs" /> : <span className="font-term text-lg text-ink-dim">{MONEY.settling}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
