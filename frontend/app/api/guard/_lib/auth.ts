import { castleForGuardKey, readGuardKey, type GuardCastleRow } from "@/lib/guard/keys";
import { TERMINAL_STATES } from "@/lib/vault";
import { err } from "../../_lib/http";

/**
 * Gate for /api/guard/*: `Authorization: Bearer gk_…` → the castle row (raw, with secrets: never return it).
 * 401 guard_key_invalid · 410 vault_closed (broken/closed: the harness should stop) · 409 not_sdk.
 */
export function guardCastle(req: Request): { ok: true; row: GuardCastleRow } | { ok: false; res: Response } {
  const row = castleForGuardKey(readGuardKey(req));
  if (!row) return { ok: false, res: err(401, "guard_key_invalid", { message: "Unknown guard key. Copy it again from your vault's plug-in panel." }) };
  if (TERMINAL_STATES.has(row.vaultState)) return { ok: false, res: err(410, "vault_closed", { vaultState: row.vaultState, message: "This vault is closed. Stop the harness." }) };
  if (row.transport !== "sdk") return { ok: false, res: err(409, "not_sdk", { message: "This vault is hosted by the arena, not plugged in." }) };
  return { ok: true, row };
}
