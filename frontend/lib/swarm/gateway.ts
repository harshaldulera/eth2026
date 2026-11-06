/**
 * The Bee API, the two calls we use: POST /bytes (upload, returns the reference) and GET /bytes/{ref}
 * (download). Plain fetch, no SDK: the API is two endpoints and a header
 * (https://docs.ethswarm.org/api). Works against a Bee node or a gateway in front of one.
 *
 * On the public gateway the batch id we send is replaced by the gateway's own, so the null stamp
 * works. On your own node it must be a usable batch you bought.
 */

export const UPLOAD_TIMEOUT_MS = 10_000;
export const REFERENCE_RE = /^[0-9a-f]{64}$/;

export type GatewayOpts = { gatewayUrl: string; batchId: string; fetch?: typeof fetch; timeoutMs?: number };

export class SwarmGatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SwarmGatewayError";
  }
}

const trim = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/** Upload bytes; returns the 64-hex Swarm reference. Throws SwarmGatewayError on refusal or timeout. */
export async function uploadBytes(body: Uint8Array, o: GatewayOpts): Promise<string> {
  const f = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${o.gatewayUrl}/bytes`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "swarm-postage-batch-id": o.batchId },
      body: body as unknown as BodyInit,
      signal: AbortSignal.timeout(o.timeoutMs ?? UPLOAD_TIMEOUT_MS),
    });
  } catch (e) {
    throw new SwarmGatewayError(`upload to ${o.gatewayUrl} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const text = await res.text();
  if (!res.ok) throw new SwarmGatewayError(`upload to ${o.gatewayUrl} refused: HTTP ${res.status} ${trim(text)}`, res.status);
  let ref: unknown;
  try {
    ref = (JSON.parse(text) as { reference?: unknown }).reference;
  } catch {
    throw new SwarmGatewayError(`upload to ${o.gatewayUrl}: unreadable reply ${trim(text)}`);
  }
  if (typeof ref !== "string" || !REFERENCE_RE.test(ref)) throw new SwarmGatewayError(`upload to ${o.gatewayUrl}: no reference in reply ${trim(text)}`);
  return ref;
}

/** Download by reference. Null when the gateway has nothing for it (404); throws on other failures. */
export async function downloadBytes(ref: string, o: Omit<GatewayOpts, "batchId">): Promise<Uint8Array | null> {
  if (!REFERENCE_RE.test(ref)) return null;
  const f = o.fetch ?? fetch;
  let res: Response;
  try {
    res = await f(`${o.gatewayUrl}/bytes/${ref}`, { signal: AbortSignal.timeout(o.timeoutMs ?? UPLOAD_TIMEOUT_MS) });
  } catch (e) {
    throw new SwarmGatewayError(`download from ${o.gatewayUrl} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new SwarmGatewayError(`download from ${o.gatewayUrl} refused: HTTP ${res.status}`, res.status);
  return new Uint8Array(await res.arrayBuffer());
}
