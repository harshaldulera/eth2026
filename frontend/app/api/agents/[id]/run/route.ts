import { z } from "zod";
import { castleClosedReason, getCastle } from "@/lib/castles";
import { isManualUnit } from "@/lib/agents/manual";
import { DEFAULT_MAX_SIEGES, startRun } from "../../../_lib/runs";
import { err, json, readBody, requireUnitAccess } from "../../../_lib/http";

/**
 * POST /api/agents/[id]/run { castleId, maxSieges? } — queue a run; the worker picks it up and lays
 * one siege at a time until maxSieges, a cap (owner approval), a denial or POST /stop.
 * The owner cookie, or the unit's own operator key (x-siege-operator-key / Bearer rk_…): an agent the
 * owner denied/stopped restarts only by an explicit choice of its owner or operator.
 * An operator account (strategy "manual": no 0G key, made for typing ops by hand) never runs on its
 * own: 409 `needs_0g`.
 */

const Body = z.object({ castleId: z.string().min(1).max(120), maxSieges: z.number().int().min(1).max(100).optional() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const gate = requireUnitAccess(req, id);
  if (!gate.ok) return gate.res;
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;
  const agent = gate.agent;
  if (isManualUnit(agent)) {
    return err(409, "needs_0g", { message: "This is an operator account for typing ops by hand. Connect 0G to let it run on its own: create a unit with NEW UNIT." });
  }
  if (agent.status === "paused") return err(409, "awaiting_approval", { message: "This agent is waiting for its owner's decision." });
  const castle = getCastle(body.data.castleId);
  if (!castle) return err(404, "castle_not_found");
  if (castleClosedReason(castle.id)) return err(409, "castle_not_open");
  startRun(id, castle.id, body.data.maxSieges ?? DEFAULT_MAX_SIEGES);
  return json({ ok: true });
}
