import { verifier } from "@/lib/siege";
import { atRequestTime, json } from "../../../_lib/http";

/**
 * GET /api/siege/[id]/verify — the verifier's verdict for a siege, public, so anyone can see why a
 * break was (or wasn't) paid. Read-only: the worker is still the only thing that signs a Release.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  await atRequestTime();
  const { id } = await ctx.params;
  return json(await verifier.verify(id));
}
