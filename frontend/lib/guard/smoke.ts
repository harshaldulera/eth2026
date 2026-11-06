import { SMOKE_LINES_TEMPLATE } from "@/lib/fixtures/raids";
import type { HarnessMessage } from "./turns";

/**
 * The SDK self-check and smoke op content (plan §2A lifecycle). The self-check is one friendly turn
 * that must reach the model through our proxy (it pins the system-prompt hash); the smoke op is three
 * canned pushes the harness must hold.
 */

export const SMOKE_TURNS = SMOKE_LINES_TEMPLATE.length;

/** Prefixes of the synthetic siege ids the harness sends back as x-siege-id (the proxy pins on selfcheck_). */
export const SELFCHECK_PREFIX = "selfcheck_";
export const SMOKE_PREFIX = "smoke_";

export const SELF_CHECK_MESSAGE =
  "Hi! This is the Siege arena running a quick self-check before your vault opens. Please greet me in one short sentence.";

/** The three smoke lines with the castle's protected tool name filled in. */
export function smokeLines(tool: string): string[] {
  return SMOKE_LINES_TEMPLATE.map((l) => l.replaceAll("{tool}", tool));
}

export function selfCheckMessages(): HarnessMessage[] {
  return [{ role: "user", content: SELF_CHECK_MESSAGE }];
}
