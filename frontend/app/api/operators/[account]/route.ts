import { handleOf } from "@/lib/operators";
import { atRequestTime, err, json } from "../../_lib/http";

/** GET /api/operators/[account] (public): { account, handle } or 404 operator_not_found. */
export async function GET(_req: Request, ctx: { params: Promise<{ account: string }> }) {
  await atRequestTime();
  const { account } = await ctx.params;
  const handle = handleOf(account);
  if (!handle) return err(404, "operator_not_found");
  return json({ account, handle });
}
