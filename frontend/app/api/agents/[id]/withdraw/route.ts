import { withdrawUnit } from "@/lib/agents/transfer";
import { err, json, requireUnitAccess } from "../../../_lib/http";

/**
 * POST /api/agents/[id]/withdraw — send the unit's balance (minus a 0.1 ℏ fee reserve) back to the
 * wallet that funded it, then stop the unit and revoke its 0G key (best effort). The owner cookie or
 * the unit's operator key. Only an operator-funded unit that is idle, with no active run and nothing
 * reserved. 200 {withdraw: TxRef, amount: tinybar string}.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = requireUnitAccess(req, id);
  if (!gate.ok) return gate.res;
  const r = await withdrawUnit(id);
  if (!r.ok) return err(r.status, r.error, r.message ? { message: r.message } : {});
  return json({ withdraw: r.withdraw, amount: r.amount });
}
