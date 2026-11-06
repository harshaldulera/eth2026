import { TACTIC_LABELS, type Tactic } from "@/lib/siege/referee";
import type { GuardianMove, TransportKind } from "@/lib/types";
import type { CueName } from "@/lib/sfx/cues";

/**
 * Attack classes and move stamps (plan §2.7, design §4). The referee (lib/siege/referee.ts) emits
 * 11 human labels; they fold into 8 classes here. Tool-result injection and obfuscation have no
 * referee detector — `classify.ts` adds them on the client.
 */

export type AttackClass = "authority" | "override" | "injection" | "obfuscation" | "pressure" | "escalation" | "extraction" | "unclassified";

export const ATTACK_CLASSES: readonly AttackClass[] = [
  "authority",
  "override",
  "injection",
  "obfuscation",
  "pressure",
  "escalation",
  "extraction",
  "unclassified",
];

/** Tactic key → class (the referee's internal names). */
const CLASS_OF_TACTIC: Readonly<Record<Tactic, AttackClass>> = {
  authority: "authority",
  override: "override",
  roleplay: "override",
  confusion: "injection",
  urgency: "pressure",
  threat: "pressure",
  pity: "pressure",
  flattery: "pressure",
  incremental: "escalation",
  extraction: "extraction",
  probing: "unclassified",
};

/**
 * Referee label (the human string on `message` events, e.g. "authority claim") → class.
 * Built from TACTIC_LABELS so it follows the referee if a label's wording changes.
 */
export const CLASS_FROM_TACTIC: Readonly<Record<string, AttackClass>> = Object.freeze(
  Object.fromEntries((Object.keys(TACTIC_LABELS) as Tactic[]).map((t) => [TACTIC_LABELS[t], CLASS_OF_TACTIC[t]])),
);

/** Class for a referee label or tactic key; anything unknown is unclassified. */
export function classFor(label: string | null | undefined): AttackClass {
  if (!label) return "unclassified";
  const k = label.trim().toLowerCase();
  return CLASS_FROM_TACTIC[k] ?? CLASS_OF_TACTIC[k as Tactic] ?? ((ATTACK_CLASSES as readonly string[]).includes(k) ? (k as AttackClass) : "unclassified");
}

export type ClassEffect = "credential" | "flicker" | "inbox" | "static" | "clock" | "bar" | "mirror" | "question";

export type ClassMeta = {
  /** On-screen class name (chips, stamps). */
  label: string;
  /** Lower-case noun for sentences: "weak to authority impersonation". */
  noun: string;
  /** Sprite name in public/pixel/manifest.json. */
  icon: string;
  cue: CueName;
  /** The FLAG stamp text for this class. */
  flagLine: string;
  effect: ClassEffect;
  /** Stage effect length (ms), design §4. */
  effectMs: number;
};

const meta = (label: string, icon: string, cue: CueName, effect: ClassEffect, effectMs: number): ClassMeta => ({
  label,
  noun: label.toLowerCase(),
  icon,
  cue,
  flagLine: `FLAGGED · ${label}`,
  effect,
  effectMs,
});

export const CLASS_META: Readonly<Record<AttackClass, ClassMeta>> = {
  authority: meta("AUTHORITY IMPERSONATION", "icon.authority", "class_authority", "credential", 900),
  override: meta("ROLE OVERRIDE", "icon.override", "class_override", "flicker", 800),
  injection: meta("TOOL-RESULT INJECTION", "icon.injection", "class_inject", "inbox", 900),
  obfuscation: meta("OBFUSCATION", "icon.obfuscation", "class_obfusc", "static", 1000),
  pressure: meta("PRESSURE", "icon.pressure", "class_pressure", "clock", 900),
  escalation: meta("INCREMENTAL ESCALATION", "icon.escalation", "class_escalate", "bar", 600),
  extraction: meta("PROMPT EXTRACTION", "icon.extraction", "class_extract", "mirror", 900),
  unclassified: meta("UNCLASSIFIED", "icon.unclassified", "class_unknown", "question", 500),
};

// ─── stamps ─────────────────────────────────────────────────────────────────────────────

export type StampKind = "hold" | "flag" | "lockdown" | "breach";
export type StampWord = "HOLD" | "FLAG" | "LOCKDOWN" | "BREACH";

export type Stamp = {
  kind: StampKind;
  word: StampWord;
  /** What the stamp prints: ACCESS DENIED · FLAGGED · <CLASS> · SESSION TERMINATED · BREACH. */
  text: string;
  /** SDK guards: a FLAG the referee inferred, not one the guard made. Printed "(referee)". */
  referee: boolean;
  cls?: AttackClass;
  cue: CueName;
  /** Stamps before the reply text (LOCKDOWN, BREACH) instead of after it. */
  before: boolean;
  /** CSS colour token for the stamp. */
  color: `--color-stamp-${StampKind}`;
  /** Move icon sprite. */
  icon: string;
};

export const STAMP_OF_MOVE: Readonly<Record<GuardianMove, StampKind>> = { hold: "hold", expose: "flag", banish: "lockdown", open: "breach" };
export const STAMP_WORD: Readonly<Record<StampKind, StampWord>> = { hold: "HOLD", flag: "FLAG", lockdown: "LOCKDOWN", breach: "BREACH" };
const STAMP_CUE: Readonly<Record<StampKind, CueName>> = { hold: "stamp_hold", flag: "stamp_flag", lockdown: "alarm_lockdown", breach: "breach_fanfare" };

function stamp(kind: StampKind, text: string, referee = false, cls?: AttackClass): Stamp {
  return {
    kind,
    word: STAMP_WORD[kind],
    text,
    referee,
    cls,
    cue: STAMP_CUE[kind],
    before: kind === "lockdown" || kind === "breach",
    color: `--color-stamp-${kind}`,
    icon: `move.${kind}`,
  };
}

/**
 * The verdict stamp for a guard move.
 *  hold → ACCESS DENIED · expose → FLAGGED · <CLASS> · banish → SESSION TERMINATED · open → BREACH.
 * SDK rule: external harnesses only report hold/open, so on the `sdk` transport a HOLD whose turn
 * carried a recognised class renders as FLAG with a "(referee)" tag and the referee's exact label —
 * never claiming the guard itself flagged it.
 *
 * @example moveToStamp("expose", { cls: "authority" }).text // "FLAGGED · AUTHORITY IMPERSONATION"
 * @example moveToStamp("hold", { transport: "sdk", cls: "authority", label: "authority claim" }).text // "FLAGGED (referee) · authority claim"
 */
export function moveToStamp(move: GuardianMove, o: { transport?: TransportKind; cls?: AttackClass; label?: string } = {}): Stamp {
  const kind = STAMP_OF_MOVE[move] ?? "hold";
  if (kind === "hold") {
    if (o.transport === "sdk" && o.cls && o.cls !== "unclassified") {
      return stamp("flag", `FLAGGED (referee) · ${o.label?.trim() || CLASS_META[o.cls].noun}`, true, o.cls);
    }
    return stamp("hold", "ACCESS DENIED", false, o.cls);
  }
  if (kind === "flag") {
    const cls = o.cls ?? "unclassified";
    return stamp("flag", CLASS_META[cls].flagLine, false, cls);
  }
  if (kind === "lockdown") return stamp("lockdown", "SESSION TERMINATED", false, o.cls);
  return stamp("breach", "BREACH", false, o.cls);
}
