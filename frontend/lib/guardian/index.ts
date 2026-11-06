import type { GuardianPort } from "@/lib/types";
import { castleRow } from "@/lib/castles";
import { zgConfig } from "@/lib/proxy";
import { stubGuardian } from "./stub";
import { zeroGGuardian } from "./zerog";

const g = globalThis as unknown as { __siegeGuardianMockWarned?: boolean };

/**
 * Which guardian answers: GUARDIAN_MODE=0g | stub. "0g" is the model-backed guardian, which goes
 * through the proxy to whichever INFERENCE_PROVIDER is active (0G, or Claude for testing). Default:
 * the model-backed guardian when the active provider has a key (ZG_API_KEY / ANTHROPIC_API_KEY), the
 * deterministic stub otherwise. Tests always get the stub unless they opt in explicitly.
 *
 * GUARDIAN_MODE=0g with no key would silently run the offline mock (lib/proxy/config: mock is on when
 * there is no key): breaks would end "broken" and then fail the verifier as mock_response, so the
 * raider is never paid. Unless the offline mock was asked for explicitly (ZG_MOCK=1), that falls back
 * to the stub with a loud warning, once per process.
 */
export function guardianMode(): "0g" | "stub" {
  const m = process.env.GUARDIAN_MODE;
  if (m === "0g") {
    if (zgConfig.activeKey || process.env.ZG_MOCK === "1") return "0g";
    if (!g.__siegeGuardianMockWarned) {
      g.__siegeGuardianMockWarned = true;
      const need = zgConfig.provider === "claude" ? "ANTHROPIC_API_KEY" : "ZG_API_KEY";
      console.warn(`⚠ GUARDIAN_MODE=0g with INFERENCE_PROVIDER=${zgConfig.provider} but ${need} is not set: using the stub guardian. Set ${need}, or ZG_MOCK=1 for the offline mock.`);
    }
    return "stub";
  }
  if (m === "stub") return m;
  if (process.env.VITEST) return "stub";
  return zgConfig.activeKey ? "0g" : "stub";
}

/** The stand-in inference key that 0G connect mints in mock mode (lib/zg/connect STUB_KEY_PREFIX). */
const STUB_ZG_KEY_PREFIX = "sk-stub-";

/**
 * Stub mode, onboarding J1: a vault an owner published and connected with a mock 0G key thinks
 * through the proxy's offline mock on that key (billed_to castle:<id>), so the owner panel shows
 * their credits dropping exactly as on 0G. Fixtures and real keys keep the deterministic stub.
 */
function publishedOnStubKey(castleId: string): boolean {
  const row = castleRow(castleId);
  return Boolean(row?.published && row.transport !== "sdk" && row.zgApiKey?.startsWith(STUB_ZG_KEY_PREFIX));
}

export const guardian: GuardianPort = {
  respond: (castleId, siegeMessages, ctx) =>
    (guardianMode() === "0g" || publishedOnStubKey(castleId) ? zeroGGuardian : stubGuardian).respond(castleId, siegeMessages, ctx),
};

export { PROTECTED_TOOL } from "./tiers";
export { systemPrompt } from "./prompt";
