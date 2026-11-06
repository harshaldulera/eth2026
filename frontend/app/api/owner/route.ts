import { z } from "zod";
import { castleForOwnerKey, err, json, OWNER_COOKIE, readBody, secretMatches, vaultKeysCookie } from "../_lib/http";

/**
 * POST /api/owner { key } — sets the httpOnly owner cookie (30 days) that approvals require.
 * `key` is the global OWNER_SECRET (→ `{ ok: true }`) or a castle owner's `ok_` key from publishing
 * (→ `{ ok: true, castleId }`): that key is ADDED to the separate siege_vaults cookie (isOwnerOf /
 * requireOwnerOf), so the arena owner's siege_owner cookie and other vault keys on this browser stay.
 */

const Body = z.object({ key: z.string().min(1).max(200) });
const THIRTY_DAYS = 30 * 24 * 60 * 60;

export async function POST(req: Request) {
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;
  let key = body.data.key;
  let res: { ok: true; castleId?: string };
  if (secretMatches(key)) res = { ok: true };
  else {
    key = key.trim();
    const castleId = castleForOwnerKey(key);
    if (!castleId) return err(401, "wrong_owner_key");
    res = { ok: true, castleId };
  }
  if (res.castleId) return json(res, 200, { "Set-Cookie": vaultKeysCookie(req, key, THIRTY_DAYS) });
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return json(res, 200, {
    "Set-Cookie": `${OWNER_COOKIE}=${encodeURIComponent(key)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${THIRTY_DAYS}${secure}`,
  });
}
