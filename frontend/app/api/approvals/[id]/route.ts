import { z } from "zod";
import { decideApproval } from "@/lib/pay";
import { err, errorMessage, isOwner, json, readBody } from "../../_lib/http";

/**
 * POST /api/approvals/[id] { decision } — the owner's call from the phone. Needs the httpOnly
 * siege_owner cookie (POST /api/owner). Approve = on-chain top-up + agent resumes; deny = agent stops.
 */

const Body = z.object({ decision: z.enum(["approved", "denied"]) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isOwner(req)) return err(401, "owner_key_required");
  const { id } = await ctx.params;
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
