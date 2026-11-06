import { draftAgent, getUnitDraft, publicDraft } from "@/lib/agents/drafts";
import { atRequestTime, err, json } from "../../../_lib/http";

/**
 * GET /api/agents/drafts/[id] — a red teamer's unit while its deposit is in flight: `{draft, agent?}`.
 * `agent` appears once the deposit landed and the arena opened the unit's account. No keys, no key
 * hash, no strategy text.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await atRequestTime();
  const { id } = await ctx.params;
  const d = getUnitDraft(id);
  if (!d) return err(404, "draft_not_found");
  const agent = draftAgent(d);
  return json({ draft: publicDraft(d), ...(agent ? { agent } : {}) });
}
