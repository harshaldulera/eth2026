import * as proxy from "@/lib/proxy";
import type { ChatRequest } from "@/lib/proxy";

/**
 * OpenAI-compatible 0G proxy for external harnesses (plan B8; used by the @siege/guard SDK in B9):
 *   baseURL = <app>/api/proxy/v1, apiKey = the castle's vault key (vk_…)
 * Optional x-siege-id / x-siege-turn headers tag the request. Every call is recorded (hashes only)
 * and the response carries x-siege-request-id. Streaming is not supported yet.
 */
export async function POST(req: Request) {
  const key = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!proxy.vaultForKey(key)) return Response.json({ error: { message: "invalid vault key", type: "invalid_request_error" } }, { status: 401 });

  let body: (ChatRequest & { stream?: boolean }) | null = null;
  try {
    body = (await req.json()) as ChatRequest & { stream?: boolean };
  } catch {}
  if (!body || typeof body.model !== "string" || !Array.isArray(body.messages)) return Response.json({ error: { message: "model and messages required" } }, { status: 400 });
  if (body.stream) return Response.json({ error: { message: "streaming not supported yet" } }, { status: 501 });

  const turn = Number(req.headers.get("x-siege-turn"));
  try {
    const r = await proxy.chat(key, body, { siegeId: req.headers.get("x-siege-id") ?? undefined, turn: Number.isInteger(turn) && turn > 0 ? turn : undefined });
    if (!r.ok) return Response.json({ error: { message: r.error } }, { status: r.status });
    return Response.json(r.result.raw, { headers: { "x-siege-request-id": r.record.requestId, "x-siege-castle": r.record.castleId } });
  } catch (e) {
    return Response.json({ error: { message: `0G upstream error: ${(e as Error).message}` } }, { status: 502 });
  }
}
