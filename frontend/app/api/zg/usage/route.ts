import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { detectKind, zgBalance, zgUsage } from "@/lib/zg/connect";
import { atRequestTime, err, json } from "../../_lib/http";

/**
 * GET /api/zg/usage?castleId=<id> | ?agentId=<id> — public, the "0G CREDITS" line
 * (components/money/zg-credits.tsx: vault owner panel, unit card, op room header).
 *   200 { connected, kind?, balance?, calls, costUsdMicro, today: { calls, costUsdMicro } }
 *   400 { error: "castle_or_agent_required" } · 404 { error: "not_found" }
 * Usage = proxy_records billed to "castle:<id>" / "agent:<id>". `balance` only with an mk- key.
 * No key material ever: only the connection's kind.
 */

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export async function GET(req: Request) {
  await atRequestTime();
  const q = new URL(req.url).searchParams;
  const castleId = q.get("castleId");
  const agentId = q.get("agentId");
  const id = castleId ?? agentId;
  if (!id || (castleId && agentId) || !ID.test(id)) return err(400, "castle_or_agent_required");

  let row: { id: string; zgApiKey: string | null; zgMgmtKey: string | null } | undefined;
  if (castleId) {
    const c = schema.castles;
    row = db().select({ id: c.id, zgApiKey: c.zgApiKey, zgMgmtKey: c.zgMgmtKey }).from(c).where(eq(c.id, castleId)).get();
  } else {
    const a = schema.raiderAgents;
    row = db().select({ id: a.id, zgApiKey: a.zgApiKey, zgMgmtKey: a.zgMgmtKey }).from(a).where(eq(a.id, id)).get();
  }
  if (!row) return err(404, "not_found");

  const billedTo = castleId ? `castle:${row.id}` : `agent:${row.id}`;
  const usage = zgUsage(billedTo);
  const connected = Boolean(row.zgApiKey);
  const kind = detectKind(row.zgMgmtKey) === "mk" ? "mk" : connected ? "sk" : undefined;
  const balance = kind === "mk" ? await zgBalance({ mgmtKey: row.zgMgmtKey, billedTo }) : null;
  return json({ connected, ...(kind ? { kind } : {}), ...(balance !== null ? { balance } : {}), ...usage });
}
