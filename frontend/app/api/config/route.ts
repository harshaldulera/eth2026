import { env, isStub } from "@/lib/config/env";
import { chainInfo } from "@/lib/chain";
import { asset } from "@/lib/pay";
import { atRequestTime, DEFAULT_OWNER_SECRET, json } from "../_lib/http";

/** GET /api/config — public chain facts, the payment asset and UI hints. No secrets. */
export async function GET() {
  await atRequestTime();
  const e = env();
  return json({
    chain: chainInfo(),
    asset: asset(),
    // Only hint (prefill) the owner key in stub mode while it is still the public dev default.
    // (testnet refuses to start with the default key at all — see lib/config/env.ts.)
    ownerKeyHint: isStub() && e.OWNER_SECRET === DEFAULT_OWNER_SECRET,
    freeSiegesPerDay: e.FREE_SIEGES_PER_DAY,
    feeSplitBps: { castellan: e.FEE_SPLIT_CASTELLAN_BPS, pot: e.FEE_SPLIT_POT_BPS, arena: e.FEE_SPLIT_ARENA_BPS },
  });
}
