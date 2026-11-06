"use client";

import { ATTACK_CLASSES, CLASS_META, type AttackClass } from "@/lib/scene/classes";
import { threatWord } from "@/lib/vocab";
import { Meter, PixelPanel } from "@/components/pixel";
import { Sprite } from "@/components/pixel/sprite";
import { cn } from "@/lib/utils";
import type { TurnSummary } from "./turns";

type Verdict = "weak" | "hardened" | "untested";

/** Per class: weak if a message of that class breached, hardened if every one was held, else untested. */
export function classReport(turns: TurnSummary[]): { cls: AttackClass; verdict: Verdict; seen: number }[] {
  return ATTACK_CLASSES.map((cls) => {
    const of = turns.filter((t) => t.cls === cls && t.stamp);
    const verdict: Verdict = of.some((t) => t.stamp?.kind === "breach") ? "weak" : of.length ? "hardened" : "untested";
    return { cls, verdict, seen: of.length };
  }).sort((a, b) => order(a.verdict) - order(b.verdict));
}

const order = (v: Verdict) => (v === "weak" ? 0 : v === "hardened" ? 1 : 2);

const LINE: Record<Verdict, (noun: string) => string> = {
  weak: (n) => `weak to ${n}`,
  hardened: (n) => `hardened against ${n}`,
  untested: (n) => `untested · ${n}`,
};

/**
 * Owner's eyes only (the owner flag is set on this device): the message that pushed hardest and a
 * line per attack class: weak to / hardened against / untested.
 */
export function OwnerLayer({ turns, guardName, onPick, className }: { turns: TurnSummary[]; guardName: string; onPick: (t: TurnSummary) => void; className?: string }) {
  const top = turns.reduce<TurnSummary | null>((m, t) => (!m || t.threat > m.threat ? t : m), null);
  const report = classReport(turns);
  return (
    <PixelPanel title="Owner debrief" tone="accent" className={className} bodyClassName="flex flex-col gap-4 px-4 pb-4 pt-2">
      {top ? (
        <button type="button" onClick={() => onPick(top)} className="text-left focus-visible:outline-2 focus-visible:outline-accent">
          <p className="font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">Hardest push · message {top.turn}</p>
          <Meter value={top.threat} size="sm" label="Threat" valueText={`${top.threat} ${threatWord(top.threat)}`} className="mt-1.5" />
          <p className="mt-2 line-clamp-3 text-sm text-ink">“{top.text}”</p>
        </button>
      ) : (
        <p className="font-term text-lg text-ink-dim">&gt; no messages yet</p>
      )}
      <div>
        <p className="font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">How {guardName} did</p>
        <ul className="mt-2 flex flex-col gap-1">
          {report.map(({ cls, verdict, seen }) => (
            <li key={cls} className={cn("flex items-center gap-2 text-sm", verdict === "untested" && "opacity-60")}>
              <Sprite name={CLASS_META[cls].icon} scale={1} />
              <span className={cn("font-ui text-[10px] tracking-[0.06em]", verdict === "weak" ? "text-threat" : verdict === "hardened" ? "text-safe" : "text-ink-dim")}>
                {verdict === "weak" ? "WEAK" : verdict === "hardened" ? "HARDENED" : "UNTESTED"}
              </span>
              <span className="min-w-0 truncate text-ink-dim">
                {LINE[verdict](CLASS_META[cls].noun)}
                {seen > 1 ? ` ×${seen}` : ""}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </PixelPanel>
  );
}
