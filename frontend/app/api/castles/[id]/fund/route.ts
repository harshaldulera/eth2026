import { and, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/lib/db";
import { castleRow } from "@/lib/castles";
import { env } from "@/lib/config/env";
import { createIntent, depositAccount } from "@/lib/pay/deposits";
import { registerPublishHandlers } from "@/lib/publish/handlers";
import { hbarToTinybar, PUBLISH_POT_MAX_HBAR } from "@/lib/publish/schema";
import { err, json, readBody, requireOwnerOf } from "../../../_lib/http";

/**
 * POST /api/castles/[id]/fund { pot? } — fund a VERIFIED plugged-in (sdk) vault by memo deposit.
 * Owner only (the castle's ok_ key or the global owner). `pot` is HBAR (1..100); default: the pot set
 * when publishing. The deposit only counts from the castle's owner account (payerFilter). When it lands
 * the arena creates the on-chain vault and the castle goes funded -> guarding. Stub: confirms inline.
 * -> 200 { deposit: { intentId, to, memo, amount, expiresAt }, state }
 *  | 401 owner_key_required | 404 castle_not_found | 409 not_sdk / not_verified | 400 pot_too_large
 */
const Body = z.object({ pot: z.number().min(1).max(PUBLISH_POT_MAX_HBAR).optional() });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  registerPublishHandlers();
  const { id } = await ctx.params;
  const denied = requireOwnerOf(req, id);
  if (denied) return denied;
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;
  const castle = castleRow(id);
  if (!castle) return err(404, "castle_not_found");
  if (castle.transport !== "sdk") return err(409, "not_sdk", { message: "Hosted vaults are funded when they are published." });
  if (castle.vaultState !== "verified") return err(409, "not_verified", { vaultState: castle.vaultState, message: "Only a verified vault can be funded." });
  const amount = body.data.pot !== undefined ? hbarToTinybar(body.data.pot) : castle.potTinybar;
  if (amount > env().PUBLISH_MAX_POT) return err(400, "pot_too_large", { max: String(env().PUBLISH_MAX_POT) });
  // FUND pressed twice: hand back the window that is still open (same amount) instead of a second one,
  // so the owner never pays two deposits for one vault.
  const T = schema.depositIntents;
  const open = db()
    .select()
    .from(T)
    .where(and(eq(T.kind, "vault-sdk"), eq(T.refId, id), inArray(T.state, ["awaiting", "underpaid"]), gt(T.expiresAt, new Date().toISOString())))
    .all()
    .find((i) => i.amountTinybar === amount);
  if (open) return json({ deposit: { intentId: open.id, to: depositAccount(), memo: open.memo, amount: String(open.amountTinybar), expiresAt: open.expiresAt }, state: open.state });
  try {
    const i = await createIntent({ kind: "vault-sdk", refId: id, amountTinybar: amount, payerFilter: castle.owner });
    return json({ deposit: { intentId: i.intentId, to: i.to, memo: i.memo, amount: i.amount, expiresAt: i.expiresAt }, state: i.state });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    return err(msg.startsWith("operator_not_configured") ? 503 : 500, msg.startsWith("operator_not_configured") ? "operator_not_configured" : "deposit_failed");
  }
}
