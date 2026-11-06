import { z } from "zod";
import { accountForOperatorKeys, HANDLE_RE, setHandle } from "@/lib/operators";
import { err, json, readBody, readOperatorKeys } from "../_lib/http";

/**
 * POST /api/operators { handle } with an operator key (x-siege-operator-key or Bearer rk_…): sets the
 * public handle of that unit's owner account, so the Hall shows it instead of a Hedera id.
 * 401 operator_key_required, 400 invalid_handle, 409 handle_taken. The key is never echoed.
 */
const Body = z.object({ handle: z.string().max(40) });

export async function POST(req: Request) {
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;
  const handle = body.data.handle.trim();
  if (!HANDLE_RE.test(handle)) return err(400, "invalid_handle", { message: "3-20 characters: letters, digits, _ or -." });
  const keys = readOperatorKeys(req);
  const { account, found } = accountForOperatorKeys(keys);
  if (!found) return err(401, "operator_key_required", { message: "Use the operator key of one of your units." });
  if (!account) return err(409, "unit_has_no_account", { message: "This unit belongs to the arena, not to a wallet." });
  const r = setHandle(account, handle);
  if (!r.ok) return err(409, r.error, { message: "That handle is taken." });
  return json({ ok: true, account: r.account, handle: r.handle });
}
