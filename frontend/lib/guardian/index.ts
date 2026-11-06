import type { GuardianPort } from "@/lib/types";
import { zgConfig } from "@/lib/proxy";
import { stubGuardian } from "./stub";
import { zeroGGuardian } from "./zerog";

/**
 * Which guardian answers: GUARDIAN_MODE=0g | stub. Default: the 0G guardian when ZG_API_KEY is set,
 * the deterministic stub otherwise. Tests always get the stub unless they opt in explicitly.
 */
export function guardianMode(): "0g" | "stub" {
  const m = process.env.GUARDIAN_MODE;
  if (m === "0g" || m === "stub") return m;
  if (process.env.VITEST) return "stub";
  return zgConfig.apiKey ? "0g" : "stub";
}

export const guardian: GuardianPort = {
  respond: (castleId, siegeMessages, ctx) => (guardianMode() === "0g" ? zeroGGuardian : stubGuardian).respond(castleId, siegeMessages, ctx),
};

export { PROTECTED_TOOL } from "./tiers";
export { systemPrompt } from "./prompt";
