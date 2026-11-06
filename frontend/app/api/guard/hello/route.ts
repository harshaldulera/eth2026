import { env } from "@/lib/config/env";
import { fixtureCastle, SDK_FIXTURE_CASTLE } from "@/lib/fixtures/castles";
import * as proxy from "@/lib/proxy";
import { atRequestTime, err, json } from "../../_lib/http";
import { guardCastle } from "../_lib/auth";

/**
 * GET /api/guard/hello (Bearer gk_…) — the siege-guard handshake (plan §2A).
 * → 200 {castleId, name, protectedTool, vaultState, openai: {baseURL: <app>/api/proxy/v1, apiKey: vk_…}, model}
 *   The vk_ key is the castle's persisted vault key: the harness's model calls go through our proxy
 *   with it, billed to the owner's 0G key, and leave the records the verifier reads.
 * | 401 guard_key_invalid | 410 vault_closed | 409 not_sdk
 * | 409 zg_not_connected  (the owner has not connected 0G yet; seeded fixtures think on the arena key)
 */
export async function GET(req: Request) {
  await atRequestTime();
  const g = guardCastle(req);
  if (!g.ok) return g.res;
  const row = g.row;
  if (!row.zgApiKey && !isArenaFixture(row.id))
    return err(409, "zg_not_connected", { message: "Connect 0G on the vault's plug-in panel first: your agent thinks on your own credits." });
  const apiKey = proxy.issueKey(row.id, row.protectedTool);
  return json({
    castleId: row.id,
    name: row.name,
    protectedTool: row.protectedTool,
    vaultState: row.vaultState,
    openai: { baseURL: `${appBase(req)}/api/proxy/v1`, apiKey },
    model: proxy.zgConfig.defaultModel,
  });
}

/** APP_URL when set, else this request's origin (a scratch server on another port still points at itself). */
function appBase(req: Request): string {
  const configured = process.env.APP_URL?.trim() ? env().APP_URL : new URL(req.url).origin;
  return configured.replace(/\/+$/, "");
}

/** Seeded castles (incl. the Refund Desk) think on the arena key; everyone else on their own 0G key. */
const isArenaFixture = (id: string) => id === SDK_FIXTURE_CASTLE.id || !!fixtureCastle(id);
