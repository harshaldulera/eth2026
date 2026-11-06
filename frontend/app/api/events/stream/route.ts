import { eventsSince, latestEvents, subscribe } from "@/lib/events/bus";
import { atRequestTime } from "../../_lib/http";

/**
 * GET /api/events/stream?siegeId=&castleId=&cursor=&tail= — Server-Sent Events (Lane C).
 *
 * - Filters: `siegeId` (one siege) or `castleId` (everything touching one castle), or neither (all).
 * - Start: `cursor` (or the Last-Event-ID header on reconnect) resumes after that event id; with no
 *   cursor, `tail=N` sends only the newest N events first, so a live ticker does not replay history.
 * - Delivery: events emitted in this process (human sieges run in Next routes) are pushed at once;
 *   events from other processes (the worker) arrive through the events table, polled every 500 ms.
 * - Heartbeat comment every 15 s; closes when the client goes away.
 */

const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;

export async function GET(req: Request) {
  await atRequestTime();
  const q = new URL(req.url).searchParams;
  const siegeId = q.get("siegeId") || undefined;
  const castleId = q.get("castleId") || undefined;
  const filter = { siegeId, castleId };
  const resumeFrom = req.headers.get("last-event-id") ?? q.get("cursor");
  let cursor = Math.max(0, Number.parseInt(resumeFrom ?? "0", 10) || 0);
  const tail = Number.parseInt(q.get("tail") ?? "", 10);
  const enc = new TextEncoder();

  let poll: ReturnType<typeof setInterval> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  const stop = () => {
    clearInterval(poll);
    clearInterval(beat);
    unsubscribe?.();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        stop();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      const send = (s: string) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          close();
        }
      };
      const write = (e: { id: number; type: string }) => {
        cursor = e.id;
        send(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      let flushing = false;
      const flush = () => {
        if (flushing || closed) return;
        flushing = true;
        try {
          for (const e of eventsSince(cursor, { ...filter, limit: 200 })) write(e);
        } catch (x) {
          send(`: error ${x instanceof Error ? x.message : String(x)}\n\n`);
        } finally {
          flushing = false;
        }
      };

      // The client may already be gone (it disconnected while the handler awaited); then the abort
      // listener below would never fire and nothing would clean up.
      if (req.signal.aborted) {
        close();
        return;
      }
      send(`retry: 2000\n: connected ${new Date().toISOString()}\n\n`);
      if (!resumeFrom && Number.isFinite(tail) && tail > 0) {
        // Read the newest id overall BEFORE the tail: an event committed between the two reads is then
        // either in the tail or after the cursor, never skipped.
        const newest = latestEvents(1)[0]?.id ?? 0;
        const first = latestEvents(tail, filter);
        for (const e of first) write(e);
        if (!first.length) cursor = newest;
      }
      flush();
      // Same-process emits wake the stream at once; the table read keeps order and dedup in one place.
      unsubscribe = subscribe(() => flush());
      poll = setInterval(flush, POLL_MS);
      beat = setInterval(() => send(`: ping ${Date.now()}\n\n`), HEARTBEAT_MS);
      req.signal.addEventListener("abort", close, { once: true });
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
