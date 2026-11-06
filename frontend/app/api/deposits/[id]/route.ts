import { intentStatus } from "@/lib/pay/deposits";
import { atRequestTime, err, json } from "../../_lib/http";

/** GET /api/deposits/[id] — public status of a deposit intent (nothing secret). */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await atRequestTime();
  const { id } = await ctx.params;
  const status = intentStatus(id);
  if (!status) return err(404, "deposit_not_found");
  return json(status);
}
