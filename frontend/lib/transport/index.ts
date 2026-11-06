/**
 * GuardianTransport seam (plan Checkpoint 0). lib/siege calls guardians ONLY through this, so the
 * engine never knows whether a guardian is hosted or an external harness (sdk, B9).
 */
import { guardian } from "@/lib/guardian";
import type { GuardianTransport } from "@/lib/types";

const hosted: GuardianTransport = {
  kind: "hosted",
  respond: (castleId, siegeMessages, ctx) => guardian.respond(castleId, siegeMessages, ctx),
};

/** Every castle is hosted until B9 adds the @siege/guard SDK transport. */
export function transportFor(castleId: string): GuardianTransport {
  void castleId;
  return hosted;
}

/** What the verifier needs from the hosted runtime, without lib/siege importing lib/guardian. */
export { guardianMode, PROTECTED_TOOL, systemPrompt } from "@/lib/guardian";
