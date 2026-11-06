import { z } from "zod";
import { err, json, OWNER_COOKIE, readBody, secretMatches } from "../_lib/http";

/** POST /api/owner { key } — sets the httpOnly owner cookie (30 days) that approvals require. */

const Body = z.object({ key: z.string().min(1).max(200) });
const THIRTY_DAYS = 30 * 24 * 60 * 60;

export async function POST(req: Request) {
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;
  if (!secretMatches(body.data.key)) return err(401, "wrong_owner_key");
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return json({ ok: true }, 200, {
    "Set-Cookie": `${OWNER_COOKIE}=${encodeURIComponent(body.data.key)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${THIRTY_DAYS}${secure}`,
  });
}
