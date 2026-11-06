import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { connection } from "next/server";
import type { z } from "zod";
import { hashKey, isKeyOf, sameHash } from "@/lib/auth/keys";
import { DEFAULT_OWNER_SECRET, env, isStub } from "@/lib/config/env";
import { db, schema } from "@/lib/db";

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

// ─── Onboarding: per-castle owner keys and unit operator keys (plan §0 "Keys") ──

/** Header carrying a castle owner's `ok_` key (scripts/CLI; the browser uses the siege_owner cookie). */
export const OWNER_KEY_HEADER = "x-siege-owner-key";
/** Header carrying one or more unit operator `rk_` keys, comma-separated. */
export const OPERATOR_KEY_HEADER = "x-siege-operator-key";

/**
 * Castle owner keys live in their OWN httpOnly cookie (comma list of `ok_` keys, newest first), so
 * publishing a vault never evicts the arena owner's siege_owner cookie or another vault's key.
 */
export const VAULTS_COOKIE = "siege_vaults";
export const MAX_VAULT_KEYS = 10;

/** Every `ok_` key on this request: the siege_vaults cookie, a legacy ok_ siege_owner cookie, the x-siege-owner-key header. */
export function readOwnerKeys(req: Request): string[] {
  const out = new Set<string>();
  for (const k of (readCookie(req, VAULTS_COOKIE) ?? "").split(",")) if (isKeyOf("ok", k.trim())) out.add(k.trim());
  const legacy = readCookie(req, OWNER_COOKIE);
  if (isKeyOf("ok", legacy)) out.add(legacy);
  const fromHeader = req.headers.get(OWNER_KEY_HEADER)?.trim();
  if (isKeyOf("ok", fromHeader)) out.add(fromHeader);
  return [...out].slice(0, MAX_VAULT_KEYS + 2);
}

/** Set-Cookie for siege_vaults with `key` added in front of the keys this browser already holds (at most MAX_VAULT_KEYS). */
export function vaultKeysCookie(req: Request, key: string, maxAgeS = 30 * 24 * 60 * 60): string {
  const held = (readCookie(req, VAULTS_COOKIE) ?? "").split(",").map((k) => k.trim()).filter((k) => isKeyOf("ok", k) && k !== key);
  const list = [key, ...held].slice(0, MAX_VAULT_KEYS);
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  return `${VAULTS_COOKIE}=${encodeURIComponent(list.join(","))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${secure}`;
}

/** The castle id whose owner_key_hash (castle row, else its publish draft) matches `ok_` key `key`, or null. */
export function castleForOwnerKey(key: string): string | null {
  if (!isKeyOf("ok", key)) return null;
  const h = hashKey(key);
  const row = db().select({ id: schema.castles.id }).from(schema.castles).where(eq(schema.castles.ownerKeyHash, h)).get();
  if (row) return row.id;
  return db().select({ id: schema.vaultDrafts.castleId }).from(schema.vaultDrafts).where(eq(schema.vaultDrafts.ownerKeyHash, h)).get()?.id ?? null;
}

/**
 * Owner of THIS castle: the global owner (OWNER_SECRET cookie), or an `ok_` key (siege_owner cookie
 * or x-siege-owner-key header) whose sha256 equals the castle's owner_key_hash — or, before the
 * deposit created the castle row, its vault_drafts row's owner_key_hash.
 */
export function isOwnerOf(req: Request, castleId: string): boolean {
  if (isOwner(req)) return true;
  const keys = readOwnerKeys(req);
  if (!keys.length) return false;
  const row = db().select({ h: schema.castles.ownerKeyHash }).from(schema.castles).where(eq(schema.castles.id, castleId)).get();
  const want = row
    ? row.h
    : db().select({ h: schema.vaultDrafts.ownerKeyHash }).from(schema.vaultDrafts).where(eq(schema.vaultDrafts.castleId, castleId)).get()?.h;
  return keys.some((k) => sameHash(want, hashKey(k)));
}

/** 401 `owner_key_required` unless `isOwnerOf(req, castleId)`. Returns null when allowed. */
export function requireOwnerOf(req: Request, castleId: string): Response | null {
  return isOwnerOf(req, castleId)
    ? null
    : err(401, "owner_key_required", { message: "Only this vault's owner can do that. Enter its owner key first." });
}

/**
 * Unit operator keys on this request: `x-siege-operator-key` (comma list) plus an
 * `Authorization: Bearer rk_…`. Only well-formed `rk_` keys, deduplicated, at most 32.
 */
export function readOperatorKeys(req: Request): string[] {
  const out = new Set<string>();
  for (const k of (req.headers.get(OPERATOR_KEY_HEADER) ?? "").split(",")) {
    const t = k.trim();
    if (isKeyOf("rk", t)) out.add(t);
  }
  const auth = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (isKeyOf("rk", auth)) out.add(auth);
  return [...out].slice(0, 32);
}

export type UnitAccess = "owner" | "operator";

/** "owner" (global owner cookie), "operator" (an rk_ key matching the unit's operator_key_hash) or null. */
export function unitAccess(req: Request, agent: { operatorKeyHash: string | null }): UnitAccess | null {
  if (isOwner(req)) return "owner";
  if (!agent.operatorKeyHash) return null;
  return readOperatorKeys(req).some((k) => sameHash(hashKey(k), agent.operatorKeyHash)) ? "operator" : null;
}

export type AgentRowForAccess = typeof schema.raiderAgents.$inferSelect;

/**
 * Gate for unit routes (run / stop / approvals / withdraw): 404 `agent_not_found`, else 401
 * `operator_key_required` without the owner cookie or the unit's `rk_` key. The row holds the unit's
 * private key and 0G keys: never return it from a route (use `toAgent`).
 */
export function requireUnitAccess(
  req: Request,
  agentId: string,
): { ok: true; access: UnitAccess; agent: AgentRowForAccess } | { ok: false; res: Response } {
  const agent = db().select().from(schema.raiderAgents).where(eq(schema.raiderAgents.id, agentId)).get();
  if (!agent) return { ok: false, res: err(404, "agent_not_found") };
  const access = unitAccess(req, agent);
  if (!access) {
    return { ok: false, res: err(401, "operator_key_required", { message: "Only this unit's operator can do that. Use its operator key." }) };
  }
  return { ok: true, access, agent };
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
