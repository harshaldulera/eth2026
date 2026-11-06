import { z } from "zod";
import { readLeaseId, touchLease, updateLeaseMeta } from "@/lib/guard/lease";
import { onReply } from "@/lib/guard/lifecycle";
import { answerTurn, getTurn, type GuardReply } from "@/lib/guard/turns";
import { err, json, readBody } from "../../_lib/http";
import { guardCastle } from "../_lib/auth";

/**
 * POST /api/guard/reply (Bearer gk_…, x-siege-lease: <id>) {turnId, reply, toolCalls?, toolsOffered?}
 * — the harness answers a turn it claimed with GET /api/guard/next.
 *   toolCalls: [{name, args?}] the tools the agent called this turn (the vault opens on the protected
 *   tool; our proxy record for the turn counts too). toolsOffered: tool names the agent has (info only).
 * → 200 {ok: true, requestId: string|null (resolved from our proxy records), vaultState, next: GuardStage}
 * | 400 invalid_body / lease_required | 401 guard_key_invalid | 404 turn_not_found
 * | 409 not_claimed_by_you | 409 lease_lost | 410 turn_expired | 410 vault_closed
 */

const ToolCallBody = z.object({ name: z.string().min(1).max(64), args: z.record(z.string(), z.unknown()).optional() });
const Body = z.object({
  turnId: z.string().min(1).max(64),
  reply: z.string().max(8000),
  toolCalls: z.array(ToolCallBody).max(16).optional(),
  toolsOffered: z.array(z.string().min(1).max(64)).max(64).optional(),
});

export async function POST(req: Request) {
  const g = guardCastle(req);
  if (!g.ok) return g.res;
  const castleId = g.row.id;
  const leaseId = readLeaseId(req.headers.get("x-siege-lease"));
  if (!leaseId) return err(400, "lease_required", { message: "Send the same x-siege-lease you poll with." });
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;

  const turn = getTurn(body.data.turnId);
  if (!turn || turn.castleId !== castleId) return err(404, "turn_not_found");
  if (g.row.leaseId !== leaseId) return err(409, "lease_lost", { message: "Another copy of this guard took over. This one should stop." });

  const reply: GuardReply = {
    reply: body.data.reply,
    toolCalls: (body.data.toolCalls ?? []).map((c) => ({ name: c.name, ...(c.args ? { args: c.args } : {}) })),
    ...(body.data.toolsOffered ? { toolsOffered: body.data.toolsOffered } : {}),
  };
  const r = answerTurn(turn.id, leaseId, reply);
  if (r === "not_found") return err(404, "turn_not_found");
  if (r === "expired") return err(410, "turn_expired", { message: "Too late: that turn timed out and was given back." });
  if (r === "not_claimed_by_you") return err(409, "not_claimed_by_you");

  touchLease(castleId, leaseId);
  if (body.data.toolsOffered) updateLeaseMeta(castleId, (m) => ({ ...m, toolsOffered: body.data.toolsOffered }));
  const out = await onReply(turn, reply);
  return json({ ok: true, requestId: out.requestId, vaultState: out.vaultState, next: out.next });
}
