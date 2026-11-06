import { timingSafeEqual } from "node:crypto";
import { connection } from "next/server";
import type { z } from "zod";
import { DEFAULT_OWNER_SECRET, env, isStub } from "@/lib/config/env";

/**
 * Shared helpers for app/api route handlers. Private folder (`_lib`): not a route.
 * Handlers use only web Request/Response (no next/headers), so scripts/demo.ts and the worker's
 * in-process dispatcher can call them directly with `new Request(...)`.
 */

/**
 * `await connection()` for GET handlers that read the DB/request, so Next never prerenders them.
 * Outside a Next request (scripts/demo.ts dispatching in-process) there is nothing to opt out of:
 * that one error is ignored, everything else propagates.
 */
export async function atRequestTime(): Promise<void> {
  try {
    await connection();
  } catch (e) {
    if (e instanceof Error && /outside a request scope/i.test(e.message)) return;
    throw e;
  }
}

export const NO_STORE = { "cache-control": "no-store" } as const;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export const err = (status: number, error: string, extra: Record<string, unknown> = {}) => json({ error, ...extra }, status);

/** Parse a JSON body with a zod schema. Returns the data or a 400 Response. */
export async function readBody<T extends z.ZodType>(req: Request, schema: T): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
  let raw: unknown = {};
  try {
    const text = await req.text();
    raw = text ? JSON.parse(text) : {};
  } catch {
    return { ok: false, res: err(400, "invalid_json") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, res: err(400, "invalid_body", { issues: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`) }) };
  }
  return { ok: true, data: parsed.data };
}

/** Same-process fetch override: scripts/demo.ts dispatches internal calls to the handlers directly. */
const g = globalThis as unknown as { __siegeInternalFetch?: typeof fetch };
export function internalFetch(): typeof fetch {
  return g.__siegeInternalFetch ?? fetch;
}

// ─── Owner cookie ────────────────────────────────────────────────────────────

export const OWNER_COOKIE = "siege_owner";
export { DEFAULT_OWNER_SECRET };

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return part.slice(i + 1).trim();
      }
    }
  }
  return undefined;
}

export function secretMatches(candidate: string | undefined | null): boolean {
  if (!candidate) return false;
  const secret = env().OWNER_SECRET;
  // Belt and braces: env() already refuses the public dev key in testnet mode.
  if (!isStub() && secret === DEFAULT_OWNER_SECRET) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const isOwner = (req: Request) => secretMatches(readCookie(req, OWNER_COOKIE));

/** 401 unless the request carries the owner cookie (POST /api/owner). Returns null when allowed. */
export function requireOwner(req: Request): Response | null {
  return isOwner(req) ? null : err(401, "owner_key_required", { message: "Only the owner can do that. Enter the owner key first." });
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
