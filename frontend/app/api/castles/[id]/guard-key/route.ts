import { castleRow } from "@/lib/castles";
import { rotateGuardKey } from "@/lib/guard/keys";
import { TERMINAL_STATES } from "@/lib/vault";
import { err, json, requireOwnerOf } from "../../../_lib/http";

/**
 * POST /api/castles/[id]/guard-key — the vault owner rotates the SDK guard key (plan §2A).
 * The old gk_ stops working at once (its harness gets 401 guard_key_invalid); the new one is returned
 * this once and never again.
 * → 200 {ok: true, castleId, guardKey: "gk_…"}
 * | 401 owner_key_required | 404 castle_not_found | 409 not_sdk | 410 vault_closed
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const denied = requireOwnerOf(req, id);
  if (denied) return denied;
  const row = castleRow(id);
  if (!row) return err(404, "castle_not_found");
  if (row.transport !== "sdk") return err(409, "not_sdk", { message: "Only a plugged-in vault has a guard key." });
  if (TERMINAL_STATES.has(row.vaultState)) return err(410, "vault_closed", { vaultState: row.vaultState });
  const guardKey = rotateGuardKey(id);
  if (!guardKey) return err(404, "castle_not_found");
  return json({ ok: true, castleId: id, guardKey });
}
