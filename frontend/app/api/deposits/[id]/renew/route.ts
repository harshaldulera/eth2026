import { renewIntent } from "@/lib/pay/renew";
// The handlers must be registered in this process (stub mode confirms the fresh intent inline).
import "@/lib/publish/handlers";
import "@/lib/agents/drafts";
import "@/lib/pay/approvals";
import { err, json } from "../../../_lib/http";

/**
 * POST /api/deposits/[id]/renew — NEW DEPOSIT WINDOW for an EXPIRED intent: a fresh intent (new memo,
 * same kind, amount and payer filter) for the same vault / unit / top-up. No auth: it moves no money and
 * only the ref's current intent can be renewed.
 * -> 200 { deposit: { intentId, to, memo, amount, expiresAt }, state }
 *  | 404 deposit_not_found | 409 not_expired | superseded | nothing_to_fund
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const r = await renewIntent(id);
    if (!r.ok) return err(r.status, r.error);
    const i = r.intent;
    return json({ deposit: { intentId: i.intentId, to: i.to, memo: i.memo, amount: i.amount, expiresAt: i.expiresAt }, state: i.state });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    return err(msg.startsWith("operator_not_configured") ? 503 : 500, msg.startsWith("operator_not_configured") ? "operator_not_configured" : "deposit_failed");
  }
}
