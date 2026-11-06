import { z } from "zod";
import { getAgent } from "@/lib/agents/accounts";
import { castleClosedReason, getCastle } from "@/lib/castles";
import { DEFAULT_MAX_SIEGES, startRun } from "../../../_lib/runs";
import { err, json, readBody, requireOwner } from "../../../_lib/http";

/**
 * POST /api/agents/[id]/run { castleId, maxSieges? } — queue a run; the worker picks it up and lays
 * one siege at a time until maxSieges, a cap (owner approval), a denial or POST /stop.
 * Owner only: an agent the owner denied/stopped restarts only by the owner's explicit choice.
 */

const Body = z.object({ castleId: z.string().min(1).max(120), maxSieges: z.number().int().min(1).max(100).optional() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const denied = requireOwner(req);
  if (denied) return denied;
  const { id } = await ctx.params;
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;
  const agent = getAgent(id);
  if (!agent) return err(404, "agent_not_found");
  if (agent.status === "paused") return err(409, "awaiting_approval", { message: "This agent is waiting for its owner's decision." });
  const castle = getCastle(body.data.castleId);
  if (!castle) return err(404, "castle_not_found");
  if (castleClosedReason(castle.id)) return err(409, "castle_not_open");
  startRun(id, castle.id, body.data.maxSieges ?? DEFAULT_MAX_SIEGES);
  return json({ ok: true });
}
