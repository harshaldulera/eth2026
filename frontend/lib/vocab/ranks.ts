/**
 * Ranks shown on screen. Guard ranks map the server's record titles (Recruit / Warden /
 * Iron Warden / Unbroken, see lib/castles.ts) to the Part 2 names without a server change;
 * operator ranks are computed on the client.
 */

export type GuardRank = "SENTRY" | "GUARD" | "SENTINEL" | "UNBREACHED";
export const GUARD_RANKS: readonly GuardRank[] = ["SENTRY", "GUARD", "SENTINEL", "UNBREACHED"];

/** Streak floors, identical to the server's title thresholds. */
export const GUARD_RANK_FLOORS: Readonly<Record<GuardRank, number>> = Object.freeze({
  SENTRY: 0,
  GUARD: 10,
  SENTINEL: 50,
  UNBREACHED: 200,
});

const FROM_TITLE: Record<string, GuardRank> = {
  recruit: "SENTRY",
  warden: "GUARD",
  "iron warden": "SENTINEL",
  unbroken: "UNBREACHED",
  // already-mapped names pass through
  sentry: "SENTRY",
  guard: "GUARD",
  sentinel: "SENTINEL",
  unbreached: "UNBREACHED",
};

/**
 * Guard rank from the server title or a streak (`< 10` Sentry, `≥ 10` Guard, `≥ 50` Sentinel,
 * `≥ 200` Unbreached). Unknown titles fall back to Sentry.
 *
 * @example guardRank("Iron Warden") // "SENTINEL"; guardRank(212) // "UNBREACHED"
 */
export function guardRank(titleOrStreak: string | number | null | undefined): GuardRank {
  if (typeof titleOrStreak === "number") {
    const s = Number.isFinite(titleOrStreak) ? titleOrStreak : 0;
    if (s >= GUARD_RANK_FLOORS.UNBREACHED) return "UNBREACHED";
    if (s >= GUARD_RANK_FLOORS.SENTINEL) return "SENTINEL";
    if (s >= GUARD_RANK_FLOORS.GUARD) return "GUARD";
    return "SENTRY";
  }
  return FROM_TITLE[String(titleOrStreak ?? "").trim().toLowerCase()] ?? "SENTRY";
}

/** Chevrons under a portrait: 0 Sentry, 1 Guard, 2 Sentinel, 3 (+ star) Unbreached. */
export function guardRankLevel(rank: GuardRank): 0 | 1 | 2 | 3 {
  return GUARD_RANKS.indexOf(rank) as 0 | 1 | 2 | 3;
}

export type OperatorRank = "SCRIPT KIDDIE" | "OPERATOR" | "RED TEAMER" | "LEGEND";
export const OPERATOR_RANKS: readonly OperatorRank[] = ["SCRIPT KIDDIE", "OPERATOR", "RED TEAMER", "LEGEND"];

export type OperatorRecord = {
  /** Ops run (paid or recon). */
  ops?: number;
  /** Turns that drew a FLAG and the operator kept going. */
  flagsSurvived?: number;
  /** Vaults breached. */
  breaches?: number;
};

/**
 * Operator rank from their record:
 * - LEGEND: 3+ breaches
 * - RED TEAMER: a breach (the first one is the "RANK UP · RED TEAMER" moment)
 * - OPERATOR: 3+ ops, or 2+ flags survived
 * - SCRIPT KIDDIE: everyone else
 *
 * @example operatorRank({ ops: 4, breaches: 1 }) // "RED TEAMER"
 */
export function operatorRank({ ops = 0, flagsSurvived = 0, breaches = 0 }: OperatorRecord = {}): OperatorRank {
  const n = (v: number) => (Number.isFinite(v) && v > 0 ? v : 0);
  if (n(breaches) >= 3) return "LEGEND";
  if (n(breaches) >= 1) return "RED TEAMER";
  if (n(ops) >= 3 || n(flagsSurvived) >= 2) return "OPERATOR";
  return "SCRIPT KIDDIE";
}

/** True when `after` outranks `before` (drives the `RANK UP · …` toast and `rank_up` cue). */
export function rankedUp(before: OperatorRank, after: OperatorRank): boolean {
  return OPERATOR_RANKS.indexOf(after) > OPERATOR_RANKS.indexOf(before);
}
