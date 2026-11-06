import { checkKey } from "@/lib/proxy/account";
import { atRequestTime, json } from "../../_lib/http";

/**
 * POST /api/account/key-check { key } — classify a user's 0G key for free (inference sk-, management
 * mk-, or invalid) so their own daily iAI credits can pay for their sieges. Never stored or logged.
 */
export async function POST(req: Request) {
  await atRequestTime();
  let key = "";
  try {
    const b = (await req.json()) as { key?: unknown };
    key = typeof b.key === "string" ? b.key.trim() : "";
  } catch {}
  if (!/^(sk|mk)-[A-Za-z0-9_-]{8,}$/.test(key)) return json({ kind: "invalid" });
  return json(await checkKey(key));
}
