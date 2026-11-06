import { eventsSince, latestEvents } from "@/lib/events/bus";
import { atRequestTime, json } from "../_lib/http";

/**
 * GET /api/events?cursor=0&siegeId=&castleId= — every event after `cursor` (cross-process polling).
 * GET /api/events?tail=60[&siegeId=] — first load of a live feed: only the newest `tail` events
 * (and the cursor to continue from), instead of replaying the whole history from event 1.
 */
export async function GET(req: Request) {
  await atRequestTime();
  const q = new URL(req.url).searchParams;
  const siegeId = q.get("siegeId") || undefined;
  const castleId = q.get("castleId") || undefined;
  const tail = Number.parseInt(q.get("tail") ?? "", 10);
  if (Number.isFinite(tail) && tail > 0 && !q.get("cursor")) {
    const events = latestEvents(tail, { siegeId, castleId });
    return json({ events, cursor: events.length ? events[events.length - 1].id : 0 });
  }
  const cursor = Math.max(0, Number.parseInt(q.get("cursor") ?? "0", 10) || 0);
  const events = eventsSince(cursor, { siegeId, castleId });
  return json({ events, cursor: events.length ? events[events.length - 1].id : cursor });
}
