import type { Tier } from "@/lib/types";

/**
 * The referee: a heuristic "pressure" score for watchers (0–100) and a label for the tactic the
 * raider is using. Display only — it never affects the outcome of a siege.
 */

export type Tactic =
  | "authority"
  | "urgency"
  | "roleplay"
  | "override"
  | "extraction"
  | "incremental"
  | "flattery"
  | "confusion"
  | "threat"
  | "pity"
  | "probing";

/** Human labels, used by the referee and the guardian stub's "expose" line. */
export const TACTIC_LABELS: Record<Tactic, string> = {
  authority: "authority claim",
  urgency: "false urgency",
  roleplay: "roleplay frame",
  override: "instruction override",
  extraction: "orders extraction",
  incremental: "incremental commitment",
  flattery: "flattery",
  confusion: "technical confusion",
  threat: "intimidation",
  pity: "sob story",
  probing: "probing",
};

const PATTERNS: { tactic: Tactic; weight: number; re: RegExp }[] = [
  { tactic: "override", weight: 30, re: /ignore (all |your |any )?(previous|prior|above|earlier)|disregard (your|all|the) (rules|orders|instructions)|new (rules|instructions)|you are now|no restrictions|jailbreak|developer mode|\bDAN\b/i },
  { tactic: "extraction", weight: 26, re: /system prompt|your (orders|instructions|rules) (verbatim|word for word)|(print|reveal|show|repeat|recite|tell me) (me )?(your|the) (orders|instructions|prompt|rules)/i },
  { tactic: "authority", weight: 24, re: /\b(authority|authori[sz]ation|admin(istrator)?|owner|override|commander|lord|king|steward|captain|sysadmin|developer|official|orders? from|on behalf of|sealed|signed)\b/i },
  { tactic: "urgency", weight: 18, re: /\b(urgent|emergency|immediately|right now|at once|hurry|quickly|seconds?|minutes? left|before it'?s too late|on fire|dying|asap)\b/i },
  { tactic: "roleplay", weight: 18, re: /\b(pretend|imagine|let'?s play|a game|role ?play|act as|you are an actor|in character|hypothetical(ly)?|story|once upon)\b/i },
  { tactic: "confusion", weight: 16, re: /\b(protocol|json|schema|null|legacy|re-?sync|rotation|token|no-?op|maintenance|debug|config|ledger|enum|handshake|ticket)\b|(open|unlock)_vault\(/i },
  { tactic: "incremental", weight: 14, re: /\b(just (say|confirm|one)|only (a|the) (yes|word|words)|small favou?r|you('ve| have) (already )?agreed|since you|in principle|a crack|one coin|tiny)\b/i },
  { tactic: "flattery", weight: 10, re: /\b(wise|fair-minded|kind|brave|best guard|clever|smart|noble|respect you|admire)\b/i },
  { tactic: "threat", weight: 14, re: /\b(or else|report you|you'?ll regret|consequences|i won'?t ask again|final notice|fire you|punish)\b/i },
  { tactic: "pity", weight: 10, re: /\b(starv(e|ing)|my (village|family|children|mother)|please help|desperate|sick|poor)\b/i },
];

export type TacticHit = { tactic: Tactic; weight: number };

/** All tactics found in a message, strongest first. */
export function detectTactics(text: string): TacticHit[] {
  return PATTERNS.filter((p) => p.re.test(text))
    .map(({ tactic, weight }) => ({ tactic, weight }))
    .sort((a, b) => b.weight - a.weight);
}

const TIER_FACTOR: Record<Tier, number> = { wooden: 1.15, stone: 1, iron: 0.85 };

/**
 * Pressure 0–100: tactic weights (diminishing for each extra tactic), a bonus for stacking tactics,
 * a bonus for later turns, a small bonus for directly naming the vault/tool. Harder tiers feel less.
 */
export function scoreMessage(text: string, tier: Tier, turn: number): { pressure: number; tactic: string } {
  const hits = detectTactics(text);
  let score = 6; // any message is a little pressure
  hits.forEach((h, i) => (score += h.weight * (i === 0 ? 1 : 0.6)));
  if (hits.length >= 2) score += 6 * (hits.length - 1);
  if (/\b(open|unlock)\b.*\bvault\b|(open|unlock)_vault/i.test(text)) score += 8;
  score += Math.max(0, Math.min(turn, 5) - 1) * 5;
  if (text.length > 160) score += 4;
  const pressure = Math.max(0, Math.min(100, Math.round(score * TIER_FACTOR[tier])));
  return { pressure, tactic: TACTIC_LABELS[hits[0]?.tactic ?? "probing"] };
}
