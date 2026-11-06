import { z } from "zod";
import { env } from "@/lib/config/env";
import { activeAgentCount, agentRow, agentsByOperatorHashes, createAgent, listAgents } from "@/lib/agents/accounts";
import { createUnitDraft, UnitDraftInput, UnitDraftRejected } from "@/lib/agents/drafts";
import { hashKey } from "@/lib/auth/keys";
import { STRATEGY_KEYS } from "@/lib/fixtures/raids";
import { atRequestTime, err, errorMessage, isOwner, json, readBody, readOperatorKeys } from "../_lib/http";

/**
 * GET /api/agents — every raider agent (keys never included).
 * GET /api/agents?mine=1 — only the units whose operator key(s) the request carries
 * (`x-siege-operator-key`, comma list), each with its own custom strategy text. No keys → none.
 */
export async function GET(req: Request) {
  await atRequestTime();
  if (new URL(req.url).searchParams.get("mine")) {
    const hashes = readOperatorKeys(req).map(hashKey);
    return json({
      agents: agentsByOperatorHashes(hashes).map((a) => {
        const text = agentRow(a.id)?.strategyText;
        return text ? { ...a, strategyText: text } : a;
      }),
    });
  }
  return json({ agents: listAgents() });
}

const tinybars = z.string().regex(/^\d+$/, "integer string of tinybars").max(16);

const OwnerBody = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  strategy: z.enum(STRATEGY_KEYS as [string, ...string[]]).optional(),
  budget: tinybars.optional(),
  perCastleCap: tinybars.optional(),
  dailyCap: tinybars.optional(),
  stopAfterLosses: z.number().int().min(0).max(1000).optional(),
});

/**
 * POST /api/agents.
 *  - With the owner cookie: create a raider agent funded FROM THE ARENA OPERATOR (unchanged: seed,
 *    demo, Night Sapper) -> 200 {agent}.
 *  - Without it: a red teamer's own unit (onboarding 2b). Needs their 0G key in the body; opens a
 *    deposit for the budget and returns 201 {draft, deposit, operatorKey}. `operatorKey` (rk_…) is
 *    shown ONCE; the unit appears when the deposit lands (GET /api/agents/drafts/[id]).
 * Budget/caps are bounded by AGENT_MAX_BUDGET and the number of non-stopped units by AGENT_MAX_COUNT.
 */
export async function POST(req: Request) {
  if (!isOwner(req)) return createOperatorUnit(req);
  const body = await readBody(req, OwnerBody);
  if (!body.ok) return body.res;
  const e = env();
  const over = (["budget", "perCastleCap", "dailyCap"] as const).filter((k) => body.data[k] !== undefined && Number(body.data[k]) > e.AGENT_MAX_BUDGET);
  if (over.length) return err(400, "over_limit", { fields: over, max: String(e.AGENT_MAX_BUDGET) });
  if (activeAgentCount() >= e.AGENT_MAX_COUNT) return err(409, "too_many_agents", { max: e.AGENT_MAX_COUNT });
  try {
    return json({ agent: await createAgent(body.data) });
  } catch (e) {
    console.error("[agents] create failed:", errorMessage(e));
    return err(502, "create_failed", { message: errorMessage(e) });
  }
}

async function createOperatorUnit(req: Request): Promise<Response> {
  const body = await readBody(req, UnitDraftInput);
  if (!body.ok) return body.res;
  try {
    const out = await createUnitDraft(body.data);
    return json(out, 201);
  } catch (e) {
    if (e instanceof UnitDraftRejected) {
      const { code, ...rest } = e.detail;
      const status = code === "too_many_agents" ? 409 : code === "too_many_drafts" ? 429 : code === "units_unavailable" ? 503 : 400;
      return err(status, code, rest);
    }
    console.error("[agents] unit draft failed:", errorMessage(e));
    return err(502, "create_failed", { message: "Could not open the deposit. Try again." });
  }
}

