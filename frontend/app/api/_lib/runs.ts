import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { StoredSiegeEvent, SiegeEvent } from "@/lib/types";
import { newId, nowIso } from "@/lib/util/ids";

/**
 * Raider-agent run queue (agent_runs table). Routes enqueue/stop runs; worker/agents.ts executes
 * them. Shared here because app/** may not import worker/**.
 */

const r = schema.agentRuns;
const ag = schema.raiderAgents;

export type AgentRunRow = typeof schema.agentRuns.$inferSelect;
export const DEFAULT_MAX_SIEGES = 20;

/** Queue a run (replacing any active one for this agent) and set the agent running. */
export function startRun(agentId: string, castleId: string, maxSieges = DEFAULT_MAX_SIEGES): AgentRunRow {
  const at = nowIso();
  return db().transaction((tx) => {
    tx.update(r)
      .set({ status: "stopped", stopReason: "replaced", endedAt: at })
      .where(and(eq(r.agentId, agentId), eq(r.status, "active")))
      .run();
    const row = tx.insert(r).values({ id: newId("run"), agentId, castleId, maxSieges, status: "active", createdAt: at }).returning().get();
    tx.update(ag).set({ status: "running" }).where(eq(ag.id, agentId)).run();
    return row;
  });
}

/** End every active run of an agent. */
export function endRuns(agentId: string, status: "done" | "stopped", reason: string): void {
  db()
    .update(r)
    .set({ status, stopReason: reason, endedAt: nowIso() })
    .where(and(eq(r.agentId, agentId), eq(r.status, "active")))
    .run();
}

export function activeRun(agentId: string): AgentRunRow | null {
  return db().select().from(r).where(and(eq(r.agentId, agentId), eq(r.status, "active"))).orderBy(desc(r.createdAt)).get() ?? null;
}

export function activeRuns(): AgentRunRow[] {
  return db().select().from(r).where(eq(r.status, "active")).all();
}

export function bumpRun(runId: string): AgentRunRow {
  return db().update(r).set({ siegesRun: sql`${r.siegesRun} + 1` }).where(eq(r.id, runId)).returning().get();
}

/** Last `limit` events that belong to an agent (payload.agentId, or one of its sieges), oldest first. */
export function agentEvents(agentId: string, limit = 50): StoredSiegeEvent[] {
  const e = schema.events;
  const siegeIds = db().select({ id: schema.sieges.id }).from(schema.sieges).where(eq(schema.sieges.agentId, agentId)).all().map((s) => s.id);
  const byPayload = sql`json_extract(${e.payload}, '$.agentId') = ${agentId}`;
  const where = siegeIds.length ? sql`(${byPayload} OR ${inArray(e.siegeId, siegeIds)})` : byPayload;
  return db()
    .select()
    .from(e)
    .where(where)
    .orderBy(desc(e.id))
    .limit(limit)
    .all()
    .reverse()
    .map((row) => ({
      id: row.id,
      siegeId: row.siegeId,
      castleId: row.castleId ?? undefined,
      type: row.type as SiegeEvent["type"],
      turn: row.turn ?? undefined,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      at: row.at,
    }));
}

