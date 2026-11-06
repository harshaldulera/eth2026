import { demoWalletOps, env, isStub } from "@/lib/config/env";
import { chainInfo } from "@/lib/chain";
import { asset } from "@/lib/pay";
import { guardianMode } from "@/lib/transport";
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
    // Which guardian answers sieges in this process: "0g" or the deterministic "stub" (the golden run records it).
    guardianMode: guardianMode(),
    // Every paid op is paid from the operator's own account. True only with the DEMO_WALLET_OPS hatch
    // (stub default): RUN OP may still pay from the arena's demo wallet when no unit is chosen.
    demoWalletOps: demoWalletOps(),
    // Smallest deposit (tinybar) that opens a unit or an operator account.
    unitMinBudget: String(e.UNIT_MIN_BUDGET),
  });
}
