/**
 * Tests only: a fake Bee API in memory, with the two upload shapes the real one has.
 *
 *   POST /bzz?name=…   a named file. Reference = sha256("bzz:" + name + content type + body), so
 *                      the same bytes, name and type always give the same reference, and never the
 *                      reference raw bytes would get. Served at GET /bzz/<ref>/ (trailing slash
 *                      required, as on the public gateway: without it, a 302 like the real one).
 *   POST /bytes        raw bytes (how transcripts were uploaded before they were named).
 *                      Reference = sha256(body). Served at GET /bytes/<ref> only.
 *
 * `state.down` makes every call fail like an unreachable host; `state.status` / `state.reply`
 * override the upload answer. `seedBytes` puts raw bytes in place, for references from before.
 */
import { createHash } from "node:crypto";

export type FakeCall = { method: string; url: string; headers: Record<string, string>; body?: Uint8Array };

export function fakeGateway() {
  const files = new Map<string, { body: Uint8Array; type: string; name: string }>();
  const raw = new Map<string, Uint8Array>();
  const calls: FakeCall[] = [];
  const state = { down: false, status: 201, reply: null as string | null };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    if (state.down) throw new TypeError("fetch failed");
    if (method === "POST") {
      const body = new Uint8Array(init!.body as Uint8Array);
      calls.push({ method, url: String(input), headers, body });
      if (state.reply !== null) return new Response(state.reply, { status: state.status });
      if (state.status !== 201) return new Response(JSON.stringify({ code: state.status, message: "payload too large" }), { status: state.status });
      if (url.pathname === "/bzz") {
        const name = url.searchParams.get("name") ?? "";
        const type = headers["content-type"] ?? "";
        const ref = createHash("sha256").update(`bzz:${name}:${type}:`).update(body).digest("hex");
        files.set(ref, { body, type, name });
        return new Response(JSON.stringify({ reference: ref }), { status: 201 });
      }
      const ref = createHash("sha256").update(body).digest("hex");
      raw.set(ref, body);
      return new Response(JSON.stringify({ reference: ref }), { status: 201 });
    }
    calls.push({ method, url: String(input), headers });
    const bzz = /^\/bzz\/([0-9a-f]{64})(\/?)$/.exec(url.pathname);
    if (bzz) {
      const f = files.get(bzz[1]);
      if (!f) return new Response("<!DOCTYPE html>not found", { status: 404, headers: { "content-type": "text/html" } });
      if (!bzz[2]) return new Response("Found", { status: 302, headers: { location: "https://bzz.link/forbidden" } });
      return new Response(f.body as unknown as BodyInit, { status: 200, headers: { "content-type": f.type, "content-disposition": `inline; filename="${f.name}"` } });
    }
    const bytes = /^\/bytes\/([0-9a-f]{64})$/.exec(url.pathname);
    const b = bytes && raw.get(bytes[1]);
    return b ? new Response(b as unknown as BodyInit, { status: 200, headers: { "content-type": "application/octet-stream" } }) : new Response("Not Found", { status: 404 });
  }) as typeof globalThis.fetch;
  /** Requests that reached the gateway (a dead gateway sees none). */
  const posts = () => calls.filter((c) => c.method === "POST");
  const gets = () => calls.filter((c) => c.method === "GET");
  /** Raw bytes already on the gateway under their /bytes reference (an upload from before). */
  const seedBytes = (body: Uint8Array) => {
    const ref = createHash("sha256").update(body).digest("hex");
    raw.set(ref, body);
    return ref;
  };
  /** Forget everything stored (a lapsed stamp). */
  const clear = () => {
    files.clear();
    raw.clear();
  };
  return { fetch: fetchImpl, files, raw, calls, state, posts, gets, seedBytes, clear };
}
