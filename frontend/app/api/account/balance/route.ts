import { getBalance } from "@/lib/proxy/account";
import { atRequestTime, err, json } from "../../_lib/http";

/** GET /api/account/balance — the user's 0G balance, read with their management key (x-0g-mgmt-key). Never stored. */
export async function GET(req: Request) {
  await atRequestTime();
  const key = req.headers.get("x-0g-mgmt-key")?.trim();
  if (!key) return err(400, "x-0g-mgmt-key header required");
  const b = await getBalance(key);
  return b ? json(b) : err(403, "key_cannot_read_balance");
}
