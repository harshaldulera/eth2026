import { EventEmitter } from "node:events";
import { and, asc, desc, eq, gt } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import type { SiegeEvent, StoredSiegeEvent } from "@/lib/types";
import { nowIso } from "@/lib/util/ids";

/**
 * The event bus. `emit` persists to the `events` table (the cross-process channel: Next routes,
 * the worker and scripts are separate processes) and notifies in-process subscribers.
 * Out-of-process readers (SSE route, approvals page, Lane C screens) poll `eventsSince`.
 */

const g = globalThis as unknown as { __siegeBus?: EventEmitter };
const emitter = (g.__siegeBus ??= new EventEmitter().setMaxListeners(100));

export function emit(e: Omit<SiegeEvent, "at"> & { at?: string }): StoredSiegeEvent {
  const event: SiegeEvent = { ...e, at: e.at ?? nowIso() };
  const row = db()
    .insert(schema.events)
    .values({
      siegeId: event.siegeId,
      castleId: event.castleId ?? null,
      type: event.type,
      turn: event.turn ?? null,
      payload: JSON.stringify(persistedPayload(event)),
      at: event.at,
    })
    .returning({ id: schema.events.id })
    .get();
  const stored: StoredSiegeEvent = { ...event, id: row.id };
  emitter.emit("event", stored);
  return stored;
}

/**
 * The events table has no transport / requestId columns: they ride in the stored payload and are
 * lifted back onto the event by the cross-process readers below (SSE, feed), so no migration is needed.
 */
function persistedPayload(e: SiegeEvent): Record<string, unknown> {
  const p: Record<string, unknown> = { ...(e.payload ?? {}) };
  if (e.transport && p.transport === undefined) p.transport = e.transport;
  if (e.requestId && p.requestId === undefined) p.requestId = e.requestId;
  return p;
}

function fromPayload(raw: string): Pick<SiegeEvent, "payload" | "transport" | "requestId"> {
  const payload = JSON.parse(raw) as Record<string, unknown>;
  const out: Pick<SiegeEvent, "payload" | "transport" | "requestId"> = { payload };
  if (payload.transport === "hosted" || payload.transport === "sdk") out.transport = payload.transport;
  if (typeof payload.requestId === "string" && payload.requestId) out.requestId = payload.requestId;
  return out;
}

/** In-process subscription. Returns an unsubscribe function. */
export function subscribe(fn: (e: StoredSiegeEvent) => void, filter?: { siegeId?: string }): () => void {
  const handler = (e: StoredSiegeEvent) => {
    if (filter?.siegeId && e.siegeId !== filter.siegeId) return;
    fn(e);
  };
  emitter.on("event", handler);
  return () => emitter.off("event", handler);
}

/** Cross-process read: every event with id > cursor, optionally for one siege. */
/** The newest `limit` events (optionally of one siege), oldest first. For a feed's first load. */
export function latestEvents(limit: number, filter?: { siegeId?: string }): StoredSiegeEvent[] {
  return db()
    .select()
    .from(schema.events)
    .where(filter?.siegeId ? eq(schema.events.siegeId, filter.siegeId) : undefined)
    .orderBy(desc(schema.events.id))
    .limit(Math.max(1, Math.min(500, limit)))
    .all()
    .reverse()
    .map((r) => ({
      id: r.id,
      siegeId: r.siegeId,
      castleId: r.castleId ?? undefined,
      type: r.type as SiegeEvent["type"],
      turn: r.turn ?? undefined,
      at: r.at,
      ...fromPayload(r.payload),
    }));
}

export function eventsSince(cursor = 0, filter?: { siegeId?: string; limit?: number }): StoredSiegeEvent[] {
  const where = filter?.siegeId
    ? and(gt(schema.events.id, cursor), eq(schema.events.siegeId, filter.siegeId))
    : gt(schema.events.id, cursor);
  return db()
    .select()
    .from(schema.events)
    .where(where)
    .orderBy(asc(schema.events.id))
    .limit(filter?.limit ?? 500)
    .all()
    .map((r) => ({
      id: r.id,
      siegeId: r.siegeId,
      castleId: r.castleId ?? undefined,
      type: r.type as SiegeEvent["type"],
      turn: r.turn ?? undefined,
      at: r.at,
      ...fromPayload(r.payload),
    }));
}
