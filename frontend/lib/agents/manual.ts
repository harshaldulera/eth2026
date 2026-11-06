/**
 * Operator accounts (client-safe): a unit row made by POST /api/agents {kind: "manual"} so its
 * operator can pay the ops they type by hand from their own money. No 0G key, no strategy, never
 * DEPLOYed (that needs a unit with 0G connected).
 */

/** `strategy` of an operator account. */
export const MANUAL_STRATEGY = "manual";

/** Is this unit an operator account (typed ops only, no 0G brain)? */
export const isManualUnit = (a: { strategy: string }): boolean => a.strategy === MANUAL_STRATEGY;

/** Demo callsigns: NEW UNIT suggests them, and an operator account opened without a name gets one. */
export const CALLSIGNS = ["Night Sapper", "Iron Mole", "Glass Fox", "Red Lantern", "Quiet Wire", "Salt Hound"] as const;

/** The first callsign no unit has; "Unit N" once they are all taken. */
export function suggestCallsign(taken: readonly string[] = []): string {
  const used = new Set(taken.map((t) => t.trim().toLowerCase()));
  return CALLSIGNS.find((c) => !used.has(c.toLowerCase())) ?? `Unit ${taken.length + 1}`;
}

/** Callsigns for a random pick: not the seeded arena unit's ("Night Sapper", scripts/seed). */
const RANDOM_CALLSIGNS = CALLSIGNS.filter((c) => c !== "Night Sapper");

/** A random callsign: an operator account opened without a name never reads "Unit". */
export function randomCallsign(rand: () => number = Math.random): string {
  return RANDOM_CALLSIGNS[Math.floor(rand() * RANDOM_CALLSIGNS.length) % RANDOM_CALLSIGNS.length];
}
