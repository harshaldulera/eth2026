import { eventsSince } from "@/lib/events/bus";
import { atRequestTime } from "../../_lib/http";

/**
 * GET /api/events/stream?siegeId=&cursor= — Server-Sent Events. Polls the events table every
 * 500ms (the worker and the routes are different processes), heartbeat comment every 15s, closes
 * when the client goes away. Resumes from Last-Event-ID. Lane C may replace this.
 */

const POLL_MS = 500;
const HEARTBEAT_MS = 15_000;

export async function GET(req: Request) {
  await atRequestTime();
  const q = new URL(req.url).searchParams;
  const siegeId = q.get("siegeId") || undefined;
  let cursor = Math.max(0, Number.parseInt(req.headers.get("last-event-id") ?? q.get("cursor") ?? "0", 10) || 0);
  const enc = new TextEncoder();

  let poll: ReturnType<typeof setInterval> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    clearInterval(poll);
    clearInterval(beat);
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
      const flush = () => {
        try {
          for (const e of eventsSince(cursor, { siegeId, limit: 200 })) {
            cursor = e.id;
            send(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
          }
        } catch (x) {
          send(`: error ${x instanceof Error ? x.message : String(x)}\n\n`);
        }
      };
      send(`retry: 2000\n: connected ${new Date().toISOString()}\n\n`);
      flush();
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
