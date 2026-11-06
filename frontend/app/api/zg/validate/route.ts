import { clientIp } from "@/lib/auth/turn";
import { z } from "zod";
import { probeZg } from "@/lib/zg/connect";
import { err, json, readBody } from "../../_lib/http";

/**
 * POST /api/zg/validate { key } — is this 0G key usable? (plan §0 "0G connectivity", the zg-connect field)
 *   200 { ok: true, kind: "mk" | "sk", balance?, models, model? }
 *   200 { ok: false, reason: "unauthorized" | "needs_keys_create" | "needs_account_read" | "unreachable" }
 *   400 invalid body · 429 rate_limited
 * Probe only: never mints, never stores, never logs or echoes the key. The key is minted/stored later
 * by the publish / new-unit routes (lib/zg/connect connectZg).
 */

const Body = z.object({ key: z.string().min(1).max(512) });

const WINDOW_MS = 60_000;
const PER_WINDOW = 20;
const g = globalThis as unknown as { __siegeZgValidateHits?: Map<string, number[]> };
const hits: Map<string, number[]> = (g.__siegeZgValidateHits ??= new Map());

/** A small per-client limit: the probe hits the 0G router, so it must not become a key-checking oracle. */
function limited(req: Request): boolean {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
  return recent.length > PER_WINDOW;
}

export async function POST(req: Request) {
  if (limited(req)) return err(429, "rate_limited", { message: "Too many key checks; wait a minute." });
  const body = await readBody(req, Body);
  if (!body.ok) return body.res;
  const r = await probeZg({ key: body.data.key });
  if (!r.ok) return json({ ok: false, reason: r.reason });
  return json({ ok: true, kind: r.kind, ...(r.balance !== undefined ? { balance: r.balance } : {}), models: r.models, ...(r.model ? { model: r.model } : {}), mock: r.mock });
}
