import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { decideApproval } from "@/lib/pay";
import { err, errorMessage, isOwner, json, readBody, unitAccess } from "../../_lib/http";

/**
 * POST /api/approvals/[id] { decision } — the call from the phone. Needs the httpOnly siege_owner cookie
 * (POST /api/owner) OR, for a red teamer's own unit, that unit's operator key (x-siege-operator-key).
 * Approve = on-chain top-up + agent resumes (arena-funded units). Operator-funded units: a cap ask just
 * raises the cap; a `budget` ask answers with a top-up `deposit` and stays pending until it lands.
 * Deny = agent stops.
 */

const Body = z.object({ decision: z.enum(["approved", "denied"]) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!isOwner(req)) {
    const row = db()
      .select({ operatorKeyHash: schema.raiderAgents.operatorKeyHash })
      .from(schema.approvalRequests)
      .innerJoin(schema.raiderAgents, eq(schema.raiderAgents.id, schema.approvalRequests.agentId))
      .where(eq(schema.approvalRequests.id, id))
      .get();
    // Unknown approvals look the same as someone else's: no probing which ids exist.
    if (!row || !unitAccess(req, row)) return err(401, "owner_key_required");
  }
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;
  try {
    const r = await decideApproval(id, body.data.decision);
    if (!r.ok) return err(r.reason === "not_found" ? 404 : 409, r.reason);
    return json({ approval: r.approval });
  } catch (e) {
    // The top-up failed; decideApproval put the request back to pending.
    console.error(`[approvals] ${id} ${body.data.decision} failed:`, errorMessage(e));
    return err(502, "top_up_failed", { message: errorMessage(e) });
  }
}
