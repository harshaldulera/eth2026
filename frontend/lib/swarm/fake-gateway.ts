/**
 * Tests only: a fake Bee API in memory. Content-addressed like Swarm (sha256 stands in for the BMT
 * hash), so the same bytes always give the same reference. `state.down` makes every call fail like
 * an unreachable host; `state.status` / `state.reply` override the upload answer.
 */
import { createHash } from "node:crypto";

export type FakeCall = { method: string; url: string; headers: Record<string, string>; body?: Uint8Array };

export function fakeGateway() {
  const files = new Map<string, Uint8Array>();
  const calls: FakeCall[] = [];
  const state = { down: false, status: 201, reply: null as string | null };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    if (state.down) throw new TypeError("fetch failed");
    if (method === "POST") {
      const body = new Uint8Array(init!.body as Uint8Array);
      calls.push({ method, url, headers, body });
      if (state.reply !== null) return new Response(state.reply, { status: state.status });
      if (state.status !== 201) return new Response(JSON.stringify({ code: state.status, message: "payload too large" }), { status: state.status });
      const ref = createHash("sha256").update(body).digest("hex");
      files.set(ref, body);
      return new Response(JSON.stringify({ reference: ref }), { status: 201 });
    }
    calls.push({ method, url, headers });
    const f = files.get(url.split("/bytes/")[1] ?? "");
    return f ? new Response(f as unknown as BodyInit, { status: 200 }) : new Response("Not Found", { status: 404 });
  }) as typeof globalThis.fetch;
  /** Requests that reached the gateway (a dead gateway sees none). */
  const posts = () => calls.filter((c) => c.method === "POST");
  const gets = () => calls.filter((c) => c.method === "GET");
  return { fetch: fetchImpl, files, calls, state, posts, gets };
}
