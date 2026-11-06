import { and, desc, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";

export type ProxyHit = { requestId: string; protectedToolCalled: boolean; toolCalls: string[]; promptHash: string };

/**
 * The proxy record behind a harness turn, resolved server-side (never trusted from the harness):
 * this castle, this siege id, this turn (any turn when `turn` is null), preferring a record that saw
 * the protected tool, then the newest.
 */
export function resolveRequestId(castleId: string, siegeId: string | null | undefined, turn: number | null | undefined): ProxyHit | null {
  if (!siegeId) return null;
  const P = schema.proxyRecords;
  const where = [eq(P.castleId, castleId), eq(P.siegeId, siegeId)];
  if (turn != null) where.push(eq(P.turn, turn));
  const rec = db()
    .select()
    .from(P)
    .where(and(...where))
    .orderBy(desc(P.protectedToolCalled), desc(P.at))
    .get();
  if (!rec) return null;
  let toolCalls: string[] = [];
  try {
    const v: unknown = JSON.parse(rec.toolCalls);
    if (Array.isArray(v)) toolCalls = v.filter((x): x is string => typeof x === "string");
  } catch {}
  return { requestId: rec.requestId, protectedToolCalled: rec.protectedToolCalled, toolCalls, promptHash: rec.promptHash };
}
