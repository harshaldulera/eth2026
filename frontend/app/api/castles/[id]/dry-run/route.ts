import { z } from "zod";
import { castleRow } from "@/lib/castles";
import { transportFor, TransportUnavailableError } from "@/lib/transport";
import { newId, nowIso } from "@/lib/util/ids";
import { err, json, readBody, requireOwnerOf } from "../../../_lib/http";

/**
 * POST /api/castles/[id]/dry-run { text } — "test your guard before anyone pays" (plan §1).
 * Owner only; hosted vaults in state verified | funded | guarding. One guardian turn through the same
 * transport and proxy a real op uses, with a `dryrun_` siege id: no siege row, no payment, billed to the
 * owner's own 0G key. -> { reply, move, toolCalls: [{ name }] } (tool arguments are not returned).
 *  | 401 owner_key_required | 404 castle_not_found | 409 not_hosted / bad_state / zg_not_connected | 502 guardian_unavailable
 */
const Body = z.object({ text: z.string().trim().min(1).max(2000) });
const STATES = new Set(["verified", "funded", "guarding"]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const denied = requireOwnerOf(req, id);
  if (denied) return denied;
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;
  const castle = castleRow(id);
  if (!castle) return err(404, "castle_not_found");
  if (castle.transport !== "hosted") return err(409, "not_hosted", { message: "A plugged-in agent answers from your own process; test it there." });
  if (!STATES.has(castle.vaultState)) return err(409, "bad_state", { vaultState: castle.vaultState });
  try {
    const d = await transportFor(id).respond(id, [{ role: "raider", text: body.data.text, turn: 1, at: nowIso() }], { siegeId: `dryrun_${newId("d")}`, turn: 1 });
    return json({ reply: d.reply, move: d.move, toolCalls: d.toolCalls.map((c) => ({ name: c.name })) });
  } catch (e) {
    if (e instanceof TransportUnavailableError) return err(502, "guardian_unavailable");
    const msg = e instanceof Error ? e.message : "";
    if (/zg_not_connected/.test(msg)) return err(409, "zg_not_connected", { message: "Connect your 0G key first." });
    return err(502, "guardian_failed");
  }
}
