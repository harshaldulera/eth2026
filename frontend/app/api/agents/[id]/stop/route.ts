import { setAgentStatus } from "@/lib/agents/accounts";
import { cancelPendingApprovals } from "@/lib/pay";
import { endRuns } from "../../../_lib/runs";
import { json, requireUnitAccess } from "../../../_lib/http";

/**
 * POST /api/agents/[id]/stop — stop the agent (the owner cookie, or the unit's operator key); the
 * worker lets an already-paid siege finish its turns. Pending approvals are closed as denied, so a
 * late "approve" cannot move money to (or restart) a stopped agent.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = requireUnitAccess(req, id);
  if (!gate.ok) return gate.res;
  setAgentStatus(id, "stopped");
  endRuns(id, "stopped", "stop_requested");
  cancelPendingApprovals(id, "agent stopped by its owner");
  return json({ ok: true });
}
