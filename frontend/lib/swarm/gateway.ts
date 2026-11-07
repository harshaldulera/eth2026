/**
 * The Bee API calls we use, plain fetch, no SDK (https://docs.ethswarm.org/api). Works against a
 * Bee node or a gateway in front of one.
 *
 *   upload    POST /bzz?name=transcript.json  (Content-Type: application/json)
 *             A single file with a name and a type, so `GET /bzz/<ref>/` serves it as JSON and a
 *             browser shows it instead of downloading anonymous bytes. Same bytes, same name, same
 *             type: same reference, so re-uploads (the keep-alive) keep the reference.
 *   download  GET /bzz/<ref>/, falling back to GET /bytes/<ref> for references uploaded before
 *             transcripts were named (raw bytes, served as application/octet-stream).
 *
 * The trailing slash on /bzz/<ref>/ matters: the public gateway redirects the slash-less form.
 * On the public gateway the batch id we send is replaced by the gateway's own, so the null stamp
 * works. On your own node it must be a usable batch you bought.
 */

export const UPLOAD_TIMEOUT_MS = 10_000;
export const REFERENCE_RE = /^[0-9a-f]{64}$/;
/** The file name every transcript is uploaded under (the envelope inside says which op it is). */
export const TRANSCRIPT_FILE = "transcript.json";

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

/** Upload a JSON document as transcript.json; returns the 64-hex Swarm reference. Throws SwarmGatewayError on refusal or timeout. */
export async function uploadBytes(body: Uint8Array, o: GatewayOpts): Promise<string> {
  const f = o.fetch ?? fetch;
  let res: Response;
  let text: string;
  try {
    res = await f(`${o.gatewayUrl}/bzz?name=${TRANSCRIPT_FILE}`, {
      method: "POST",
      headers: { "content-type": "application/json", "swarm-postage-batch-id": o.batchId },
      body: body as unknown as BodyInit,
      signal: AbortSignal.timeout(o.timeoutMs ?? UPLOAD_TIMEOUT_MS),
    });
    text = await res.text(); // the timeout covers the body too
  } catch (e) {
    throw new SwarmGatewayError(`upload to ${o.gatewayUrl} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
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

/** One GET: the body, or null on 404. */
async function getOrNull(url: string, o: Omit<GatewayOpts, "batchId">): Promise<Uint8Array | null> {
  const f = o.fetch ?? fetch;
  try {
    const res = await f(url, { signal: AbortSignal.timeout(o.timeoutMs ?? UPLOAD_TIMEOUT_MS) });
    if (res.status === 404) return null;
    if (!res.ok) throw new SwarmGatewayError(`download from ${o.gatewayUrl} refused: HTTP ${res.status}`, res.status);
    return new Uint8Array(await res.arrayBuffer()); // the timeout covers the body too
  } catch (e) {
    if (e instanceof SwarmGatewayError) throw e;
    throw new SwarmGatewayError(`download from ${o.gatewayUrl} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Download by reference (named file first, then raw bytes). Null when neither has it; throws on other failures. */
export async function downloadBytes(ref: string, o: Omit<GatewayOpts, "batchId">): Promise<Uint8Array | null> {
  if (!REFERENCE_RE.test(ref)) return null;
  return (await getOrNull(`${o.gatewayUrl}/bzz/${ref}/`, o)) ?? (await getOrNull(`${o.gatewayUrl}/bytes/${ref}`, o));
}
