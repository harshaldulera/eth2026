import type { GuardianPort } from "@/lib/types";
import { zgConfig } from "@/lib/proxy";
import { stubGuardian } from "./stub";
import { zeroGGuardian } from "./zerog";

const g = globalThis as unknown as { __siegeGuardianMockWarned?: boolean };

/**
 * Which guardian answers: GUARDIAN_MODE=0g | stub. Default: the 0G guardian when ZG_API_KEY is set,
 * the deterministic stub otherwise. Tests always get the stub unless they opt in explicitly.
 *
 * GUARDIAN_MODE=0g with no ZG_API_KEY would silently run the offline mock (lib/proxy/config: mock is
 * on when there is no key): breaks would end "broken" and then fail the verifier as mock_response, so
 * the raider is never paid. Unless the offline mock was asked for explicitly (ZG_MOCK=1), that falls
 * back to the stub with a loud warning, once per process.
 */
export function guardianMode(): "0g" | "stub" {
  const m = process.env.GUARDIAN_MODE;
  if (m === "0g") {
    if (zgConfig.apiKey || process.env.ZG_MOCK === "1") return "0g";
    if (!g.__siegeGuardianMockWarned) {
      g.__siegeGuardianMockWarned = true;
      console.warn("⚠ GUARDIAN_MODE=0g but ZG_API_KEY is not set: using the stub guardian. Set ZG_API_KEY, or ZG_MOCK=1 for the offline 0G mock.");
    }
    return "stub";
  }
  if (m === "stub") return m;
  if (process.env.VITEST) return "stub";
  return zgConfig.apiKey ? "0g" : "stub";
}

export const guardian: GuardianPort = {
  respond: (castleId, siegeMessages, ctx) => (guardianMode() === "0g" ? zeroGGuardian : stubGuardian).respond(castleId, siegeMessages, ctx),
};

export { PROTECTED_TOOL } from "./tiers";
export { systemPrompt } from "./prompt";
