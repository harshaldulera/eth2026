import { toAgent } from "@/lib/agents/accounts";
import { unitBalance } from "@/lib/agents/transfer";
import { approvalsForAgent } from "@/lib/pay";
import { listSieges } from "@/lib/siege";
import { zgUsage } from "@/lib/zg/connect";
import { agentEvents } from "../../_lib/runs";
import { atRequestTime, err, json, unitAccess } from "../../_lib/http";
import { db, schema } from "@/lib/db";
import { eq } from "drizzle-orm";

/**
 * GET /api/agents/[id] — the agent, its recent sieges, its approval requests and its last 50 events,
 * plus (onboarding 2b) `balance` (the unit's account, tinybar string: mirror node, 15 s cache; stub:
 * budget - spent), `zgUsage` (calls and cost billed to this unit's own 0G key) and `access`
 * ("owner" | "operator" | null: what this request may do). The unit's `strategyText` is only included
 * for its operator or the owner.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await atRequestTime();
  const { id } = await ctx.params;
  const row = db().select().from(schema.raiderAgents).where(eq(schema.raiderAgents.id, id)).get();
  if (!row) return err(404, "agent_not_found");
  const access = unitAccess(req, row);
  const agent = toAgent(row);
  const balance = await unitBalance(id);
  return json({
    agent: access && row.strategyText ? { ...agent, strategyText: row.strategyText } : agent,
    sieges: listSieges({ agentId: id, limit: 20 }),
    approvals: approvalsForAgent(id),
    events: agentEvents(id, 50),
    ...(balance !== null ? { balance: balance.toString() } : {}),
    zgUsage: zgUsage(`agent:${id}`),
    access,
  });
}
