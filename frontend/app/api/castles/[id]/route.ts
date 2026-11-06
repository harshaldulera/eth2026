import { and, eq, isNotNull } from "drizzle-orm";
import { getCastle } from "@/lib/castles";
import { auditTrail } from "@/lib/chain";
import { env } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { listSieges } from "@/lib/siege";
import type { Castle } from "@/lib/types";
import { zgUsage } from "@/lib/zg/connect";
import { atRequestTime, err, json } from "../../_lib/http";

/**
 * Held / banished paid ops that reached the chain, and the owner's cut of their fees
 * (floor(fee x FEE_SPLIT_CASTELLAN_BPS / 10000) each, what SiegeVault pays the castellan).
 */
function earningsOf(castle: Castle): NonNullable<Castle["earnings"]> {
  const S = schema.sieges;
  const held = db()
    .select({ n: S.id })
    .from(S)
    .where(and(eq(S.castleId, castle.id), eq(S.free, false), isNotNull(S.attemptTx)))
    .all()
    .length;
  const perOp = (BigInt(castle.fee) * BigInt(env().FEE_SPLIT_CASTELLAN_BPS)) / BigInt(10_000);
  return { heldOps: held, ownerCut: String(perOp * BigInt(held)), potNow: castle.pot };
}

/**
 * GET /api/castles/[id] — castle, its 20 most recent sieges and its HCS audit trail.
 * The castle carries `earnings { heldOps, ownerCut, potNow }` and, for a guard with a 0G key,
 * `zg { connected, kind, calls, costUsdMicro }` (the balance is at GET /api/zg/usage). Never orders,
 * tool results or keys.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await atRequestTime();
  const { id } = await ctx.params;
  const base = getCastle(id);
  if (!base) return err(404, "castle_not_found");
  const castle: Castle = { ...base, earnings: earningsOf(base) };
  if (castle.zg?.connected) {
    const u = zgUsage(`castle:${id}`);
    castle.zg = { ...castle.zg, calls: u.calls, costUsdMicro: u.costUsdMicro };
  }
  return json({ castle, sieges: listSieges({ castleId: id, limit: 20 }), audit: auditTrail(id) });
}
