import { getAgent } from "@/lib/agents/accounts";
import { approvalsForAgent } from "@/lib/pay";
import { listSieges } from "@/lib/siege";
import { agentEvents } from "../../_lib/runs";
import { atRequestTime, err, json } from "../../_lib/http";

/** GET /api/agents/[id] — the agent, its recent sieges, its approval requests and its last 50 events. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await atRequestTime();
  const { id } = await ctx.params;
  const agent = getAgent(id);
  if (!agent) return err(404, "agent_not_found");
  return json({
    agent,
    sieges: listSieges({ agentId: id, limit: 20 }),
    approvals: approvalsForAgent(id),
    events: agentEvents(id, 50),
  });
}
