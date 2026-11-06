import { z } from "zod";
import { env } from "@/lib/config/env";
import { createAgent, listAgents } from "@/lib/agents/accounts";
import { STRATEGY_KEYS } from "@/lib/fixtures/raids";
import { atRequestTime, err, errorMessage, json, readBody, requireOwner } from "../_lib/http";

/** GET /api/agents — every raider agent (keys never included). */
export async function GET() {
  await atRequestTime();
  return json({ agents: listAgents() });
}

const tinybars = z.string().regex(/^\d+$/, "integer string of tinybars").max(16);

const Body = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  strategy: z.enum(STRATEGY_KEYS as [string, ...string[]]).optional(),
  budget: tinybars.optional(),
  perCastleCap: tinybars.optional(),
  dailyCap: tinybars.optional(),
  stopAfterLosses: z.number().int().min(0).max(1000).optional(),
});

/**
 * POST /api/agents — create a raider agent (testnet per-agent mode: a Hedera account funded with
 * `budget` FROM THE ARENA OPERATOR). Owner only; budget/caps are bounded by AGENT_MAX_BUDGET and the
 * number of agents by AGENT_MAX_COUNT, so nobody can drain the operator that settles every siege.
 */
export async function POST(req: Request) {
  const denied = requireOwner(req);
  if (denied) return denied;
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;
  const e = env();
  const over = (["budget", "perCastleCap", "dailyCap"] as const).filter((k) => body.data[k] !== undefined && Number(body.data[k]) > e.AGENT_MAX_BUDGET);
  if (over.length) return err(400, "over_limit", { fields: over, max: String(e.AGENT_MAX_BUDGET) });
  if (listAgents().length >= e.AGENT_MAX_COUNT) return err(409, "too_many_agents", { max: e.AGENT_MAX_COUNT });
  try {
    return json({ agent: await createAgent(body.data) });
  } catch (e) {
    console.error("[agents] create failed:", errorMessage(e));
    return err(502, "create_failed", { message: errorMessage(e) });
  }
}
