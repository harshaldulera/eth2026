import { getAgent, setAgentStatus } from "@/lib/agents/accounts";
import { cancelPendingApprovals } from "@/lib/pay";
import { endRuns } from "../../../_lib/runs";
import { err, json, requireOwner } from "../../../_lib/http";

/**
 * POST /api/agents/[id]/stop — stop the agent (owner only); the worker lets an already-paid siege
 * finish its turns. Pending approvals are closed as denied, so a late "approve" cannot move money
 * to (or restart) a stopped agent.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireOwner(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  if (!getAgent(id)) return err(404, "agent_not_found");
  setAgentStatus(id, "stopped");
  endRuns(id, "stopped", "stop_requested");
  cancelPendingApprovals(id, "agent stopped by its owner");
  return json({ ok: true });
}
