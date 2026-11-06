/**
 * 0G connectivity: a guard's or unit's owner pays for its thinking with their OWN 0G credits
 * (plan siege-onboarding-plan.md §0 "0G connectivity"; 0G bounty: "sign in with your 0G account and
 * spend your own daily credits").
 *
 * Router (docs.0g.ai … /router/authentication, /router/account/deposits, 0gfoundation.github.io/0g-router):
 *   sk- API key        → inference only; GET /v1/account/* answers 403 insufficient_scope
 *   mk- management key → scopes account:read (GET /v1/account/balance …), keys:create (POST /v1/api-keys),
 *                        keys:manage (PATCH|DELETE /v1/api-keys/:id); never billed, can't run inference
 *   GET  /v1/account/balance → { address, total_balance, deposit_balance, credit_balance?, currency?, … }
 *                              amounts are neuron strings (1e18 = 1 0G) for 0G accounts
 *   POST /v1/api-keys {name} → { key: "sk-…", key_id, key_preview, name, … }  (secret shown once)
 *   DELETE /v1/api-keys/:keyId → { key_id, message }
 *
 *   connectZg({key, label}) mk- → read balance, mint a dedicated sk- named `siege:<label>`
 *                           sk- → probe it, use it as is (no balance)
 *   probeZg({key})          the validate route: same checks, never mints
 *   revokeZg({mgmtKey, keyId}) best effort, on vault close / unit stop
 *   zgBalance({mgmtKey})    15 s cache
 *   zgUsage(billedTo)       calls + summed cost from proxy_records (today and all time)
 *
 * Keys are never logged and never returned by anything here except the minted inference key, which
 * the caller stores (castles/raider_agents.zg_api_key) and never returns from an API.
 *
 * Mock mode (no network): ZG_CONNECT_MOCK=1, or (unless ZG_CONNECT_MOCK=0) the team proxy is in mock
 * mode / GUARDIAN_MODE=stub. Any key matching /^(mk|sk)-./ is accepted and the balance is a
 * deterministic fake that drops by every call billed to that guard or unit, so a stub demo shows the
 * credits going down. With CHAIN_MODE=stub and an unreachable router, connect/probe fall back to mock.
 */
import { createHash } from "node:crypto";
import { and, eq, gte, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { env, isStub } from "@/lib/config/env";
import { zgConfig } from "@/lib/proxy/config";

export { ZgNotConnectedError, requireUserBilling, billingFor, needsUserBilling, billedToOf, billedToFor } from "./billing";
export type { BillingRow, CastleBillingRow, AgentBillingRow } from "./billing";

export type ZgKind = "mk" | "sk";
export type ZgFailReason = "unauthorized" | "needs_keys_create" | "needs_account_read" | "unreachable";
export type ZgFail = { ok: false; reason: ZgFailReason };

export type ZgConnectedMk = {
  ok: true;
  kind: "mk";
  /** Credits left (0G), formatted; null when the router's answer had no readable balance. */
  balance: string | null;
  /** The sk- we minted for this guard/unit (`siege:<label>`). Store it; never return it. */
  inferenceKey: string;
  keyId: string | null;
  mgmtKey: string;
  models: string[];
  model?: string;
  mock: boolean;
};
export type ZgConnectedSk = { ok: true; kind: "sk"; inferenceKey: string; models: string[]; model?: string; mock: boolean };
export type ZgConnectResult = ZgConnectedMk | ZgConnectedSk | ZgFail;

export type ZgProbeResult = { ok: true; kind: ZgKind; balance?: string; models: string[]; model?: string; mock: boolean } | ZgFail;

export type ZgUsageTotals = { calls: number; costUsdMicro: string };
export type ZgUsage = ZgUsageTotals & { today: ZgUsageTotals };

/** What a mock-billed call costs (micro-USD), so the stub balance visibly drops. */
export const STUB_CALL_COST_USD_MICRO = "12000";
/** Prefix of inference keys minted in mock mode: lib/proxy routes these to the mock provider. */
export const STUB_KEY_PREFIX = "sk-stub-";

const BALANCE_TTL_MS = 15_000;
const TIMEOUT_MS = 8_000;
const MAX_MODELS = 24;

// ─── key kind and mode ──────────────────────────────────────────────────────────────────────

/** "mk" | "sk" from the key's prefix, null for anything else (trimmed; at least one char after the dash). */
export function detectKind(key: string | null | undefined): ZgKind | null {
  const k = (key ?? "").trim();
  if (!/^(mk|sk)-\S+$/.test(k) || k.length > 512) return null;
  return k.startsWith("mk-") ? "mk" : "sk";
}

/** Is 0G connect running offline (no router calls at all)? */
export function zgConnectMock(): boolean {
  const flag = process.env.ZG_CONNECT_MOCK;
  if (flag === "1") return true;
  if (flag === "0") return false;
  return zgConfig.mock || process.env.GUARDIAN_MODE === "stub";
}

/** May an unreachable router fall back to mock? Only in CHAIN_MODE=stub, never when ZG_CONNECT_MOCK=0. */
function mayFallBackToMock(): boolean {
  if (process.env.ZG_CONNECT_MOCK === "0") return false;
  try {
    return isStub();
  } catch {
    return false;
  }
}

const routerUrl = () => env().ZG_ROUTER_URL;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

// ─── router calls ───────────────────────────────────────────────────────────────────────────

type Hit = { status: number; json: unknown } | { status: 0; json: null };

async function call(path: string, init: { key?: string; method?: string; body?: unknown } = {}): Promise<Hit> {
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (init.key) headers.Authorization = `Bearer ${init.key}`;
    if (init.body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${routerUrl()}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {}
    return { status: res.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Format a 0G amount with up to 4 decimals ("24.988", "3"). */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return (Math.round(n * 1e4) / 1e4).toFixed(4).replace(/\.?0+$/, "") || "0";
}

/**
 * The spendable balance out of a /v1/account/balance answer, defensively: `total_balance`, else
 * `balance`, else deposit + credit. Integer strings of 13+ digits are neuron (1e18 = 1 0G); a USD
 * account (`currency: "usd"`) reports micro-USD integers; plain decimals are taken as they are.
 */
export function parseBalance(body: unknown): string | null {
  const j = obj(body);
  const usd = typeof j.currency === "string" && /usd/i.test(j.currency);
  const amount = (v: unknown): number | null => {
    if (typeof v === "number" && Number.isFinite(v)) return usd && Number.isInteger(v) ? v / 1e6 : v;
    if (typeof v !== "string" || !v.trim()) return null;
    const s = v.trim();
    if (/^-?\d+$/.test(s)) {
      if (usd) return Number(s) / 1e6;
      if (s.replace("-", "").length >= 13) {
        const big = BigInt(s);
        return Number(big / BigInt(1e12)) / 1e6;
      }
      return Number(s);
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  for (const k of ["total_balance", "balance", "available_balance"]) {
    const n = amount(j[k]);
    if (n !== null) return fmt(n);
  }
  const dep = amount(j.deposit_balance);
  const cred = amount(j.credit_balance);
  if (dep !== null || cred !== null) return fmt((dep ?? 0) + (cred ?? 0));
  const data = obj(j.data);
  return Object.keys(data).length ? parseBalance({ currency: j.currency, ...data }) : null;
}

/** The secret and id of a freshly created key, whatever the router calls them. */
export function parseCreatedKey(body: unknown): { key: string | null; keyId: string | null } {
  const top = obj(body);
  const scopes = [top, obj(top.data), obj(top.api_key), obj(top.result)];
  let key: string | null = null;
  let keyId: string | null = null;
  for (const s of scopes) {
    for (const f of ["key", "api_key", "secret", "secret_key", "token", "value"]) {
      if (!key && typeof s[f] === "string" && /^sk-/.test(s[f] as string)) key = s[f] as string;
    }
    for (const f of ["key_id", "id", "keyId"]) {
      if (!keyId && (typeof s[f] === "string" || typeof s[f] === "number") && String(s[f]) && !/^sk-/.test(String(s[f]))) keyId = String(s[f]);
    }
  }
  if (!key && typeof top.api_key === "string" && /^sk-/.test(top.api_key)) key = top.api_key;
  return { key, keyId };
}

function pickModel(models: string[]): string | undefined {
  return models.includes(zgConfig.defaultModel) ? zgConfig.defaultModel : models[0];
}

async function listModels(key?: string): Promise<{ status: number; models: string[] }> {
  const r = await call("/models", { key });
  const data = obj(r.json).data;
  const models = Array.isArray(data)
    ? data
        .map((m) => obj(m).id)
        .filter((id): id is string => typeof id === "string")
        .slice(0, MAX_MODELS)
    : [];
  return { status: r.status, models };
}

type BalanceRead = { ok: true; balance: string | null } | ZgFail;

async function readBalance(mgmtKey: string): Promise<BalanceRead> {
  const r = await call("/account/balance", { key: mgmtKey });
  if (r.status === 200) return { ok: true, balance: parseBalance(r.json) };
  if (r.status === 401) return { ok: false, reason: "unauthorized" };
  if (r.status === 403) return { ok: false, reason: "needs_account_read" };
  return { ok: false, reason: "unreachable" };
}

/** sk-: /v1/models with the key, then /v1/account/balance (403 = a live inference key, 401 = not). */
async function probeSk(key: string): Promise<{ ok: true; models: string[] } | ZgFail> {
  const m = await listModels(key);
  if (m.status === 401) return { ok: false, reason: "unauthorized" };
  if (m.status !== 200) return { ok: false, reason: "unreachable" };
  // /v1/models may be public: the account probe tells a revoked or made-up key apart.
  const acct = await call("/account/balance", { key });
  if (acct.status === 401) return { ok: false, reason: "unauthorized" };
  return { ok: true, models: m.models };
}

// ─── mock ───────────────────────────────────────────────────────────────────────────────────

const STUB_MODELS = ["gpt-5.4-mini", "qwen3.7-flash", "0gm-1.0-35b-a3b"];

/** Deterministic fake starting balance for a key: 20.0000–39.9900 credits. */
function stubStart(key: string): number {
  return 20 + (parseInt(sha(key).slice(0, 8), 16) % 2000) / 100;
}

/** Fake balance: the key's starting credits minus every call billed to `billedTo` (1 credit = $1). */
export function stubBalance(key: string, billedTo?: string): string {
  const spent = billedTo ? Number(BigInt(zgUsage(billedTo).costUsdMicro)) / 1e6 : 0;
  return fmt(Math.max(0, stubStart(key) - spent));
}

function mockProbe(key: string): ZgProbeResult {
  const kind = detectKind(key);
  if (!kind) return { ok: false, reason: "unauthorized" };
  return { ok: true, kind, ...(kind === "mk" ? { balance: stubBalance(key) } : {}), models: STUB_MODELS, model: pickModel(STUB_MODELS), mock: true };
}

function mockConnect(key: string, label: string): ZgConnectResult {
  const kind = detectKind(key);
  if (!kind) return { ok: false, reason: "unauthorized" };
  const models = STUB_MODELS;
  if (kind === "sk") return { ok: true, kind, inferenceKey: key, models, model: pickModel(models), mock: true };
  const h = sha(`${key}\n${label}`);
  return {
    ok: true,
    kind,
    balance: stubBalance(key),
    inferenceKey: `${STUB_KEY_PREFIX}${h.slice(0, 32)}`,
    keyId: `stub_${h.slice(32, 44)}`,
    mgmtKey: key,
    models,
    model: pickModel(models),
    mock: true,
  };
}

// ─── public API ─────────────────────────────────────────────────────────────────────────────

/** `siege:<label>` with the label cut to safe characters (router key names are free text; keep them tidy). */
export function keyName(label: string): string {
  const clean = label.replace(/[^A-Za-z0-9:_.-]/g, "-").slice(0, 64) || "unnamed";
  return `siege:${clean}`;
}

/**
 * Connect a pasted key. mk- reads the balance (account:read) and mints a dedicated sk- named
 * `siege:<label>` (keys:create); sk- is probed and used as is. Never logs the key.
 */
export async function connectZg({ key, label }: { key: string; label: string }): Promise<ZgConnectResult> {
  const k = key.trim();
  const kind = detectKind(k);
  if (!kind) return { ok: false, reason: "unauthorized" };
  if (zgConnectMock()) return mockConnect(k, label);

  if (kind === "sk") {
    const p = await probeSk(k);
    if (!p.ok) return p.reason === "unreachable" && mayFallBackToMock() ? mockConnect(k, label) : p;
    return { ok: true, kind, inferenceKey: k, models: p.models, model: pickModel(p.models), mock: false };
  }

  const bal = await readBalance(k);
  if (!bal.ok) return bal.reason === "unreachable" && mayFallBackToMock() ? mockConnect(k, label) : bal;

  const created = await call("/api-keys", { key: k, method: "POST", body: { name: keyName(label) } });
  if (created.status === 401) return { ok: false, reason: "unauthorized" };
  if (created.status === 403) return { ok: false, reason: "needs_keys_create" };
  if (created.status < 200 || created.status >= 300) return { ok: false, reason: "unreachable" };
  const minted = parseCreatedKey(created.json);
  if (!minted.key) {
    // Created but unreadable: don't leave an orphan key on the owner's account.
    if (minted.keyId) await revokeZg({ mgmtKey: k, keyId: minted.keyId });
    return { ok: false, reason: "unreachable" };
  }
  const m = await listModels(minted.key);
  balanceCache.set(cacheKey(k), { at: Date.now(), value: bal.balance });
  return { ok: true, kind, balance: bal.balance, inferenceKey: minted.key, keyId: minted.keyId, mgmtKey: k, models: m.models, model: pickModel(m.models), mock: false };
}

/** POST /api/zg/validate: is this key usable, what kind, what balance. Never mints or stores. */
export async function probeZg({ key }: { key: string }): Promise<ZgProbeResult> {
  const k = key.trim();
  const kind = detectKind(k);
  if (!kind) return { ok: false, reason: "unauthorized" };
  if (zgConnectMock()) return mockProbe(k);

  if (kind === "sk") {
    const p = await probeSk(k);
    if (!p.ok) return p.reason === "unreachable" && mayFallBackToMock() ? mockProbe(k) : p;
    return { ok: true, kind, models: p.models, model: pickModel(p.models), mock: false };
  }
  const bal = await readBalance(k);
  if (!bal.ok) return bal.reason === "unreachable" && mayFallBackToMock() ? mockProbe(k) : bal;
  // An mk- can't run inference; the model list is public on the router (best effort, no key sent).
  const m = await listModels();
  return { ok: true, kind, ...(bal.balance !== null ? { balance: bal.balance } : {}), models: m.models, model: pickModel(m.models), mock: false };
}

/** Revoke the sk- we minted (DELETE /v1/api-keys/:id). Best effort: never throws; true when revoked. */
export async function revokeZg({ mgmtKey, keyId }: { mgmtKey?: string | null; keyId?: string | null }): Promise<boolean> {
  if (!mgmtKey || !keyId) return false;
  if (zgConnectMock() || keyId.startsWith("stub_")) return true;
  const r = await call(`/api-keys/${encodeURIComponent(keyId)}`, { key: mgmtKey, method: "DELETE" });
  return (r.status >= 200 && r.status < 300) || r.status === 404;
}

const g = globalThis as unknown as { __siegeZgBalance?: Map<string, { at: number; value: string | null }> };
const balanceCache: Map<string, { at: number; value: string | null }> = (g.__siegeZgBalance ??= new Map());
const cacheKey = (mgmtKey: string) => sha(mgmtKey);

/**
 * Credits left on an mk- key (null when unreadable or no key). 15 s cache per key. In mock mode
 * the fake balance minus the calls billed to `billedTo` (no cache, so it drops on the next poll).
 */
export async function zgBalance({ mgmtKey, billedTo }: { mgmtKey?: string | null; billedTo?: string }): Promise<string | null> {
  if (!mgmtKey || detectKind(mgmtKey) !== "mk") return null;
  if (zgConnectMock()) return stubBalance(mgmtKey, billedTo);
  const ck = cacheKey(mgmtKey);
  const hit = balanceCache.get(ck);
  if (hit && Date.now() - hit.at < BALANCE_TTL_MS) return hit.value;
  const r = await readBalance(mgmtKey);
  if (!r.ok && r.reason === "unreachable" && mayFallBackToMock()) return stubBalance(mgmtKey, billedTo);
  const value = r.ok ? r.balance : null;
  balanceCache.set(ck, { at: Date.now(), value });
  return value;
}

/** For tests. */
export function clearZgBalanceCache(): void {
  balanceCache.clear();
}

function usageSince(billedTo: string, sinceIso?: string): ZgUsageTotals {
  const p = schema.proxyRecords;
  const where = sinceIso ? and(eq(p.billedTo, billedTo), gte(p.at, sinceIso)) : eq(p.billedTo, billedTo);
  const row = db()
    .select({
      calls: sql<number>`count(*)`,
      cost: sql<string>`coalesce(sum(cast(${p.costUsdMicro} as integer)), 0)`,
    })
    .from(p)
    .where(where)
    .get();
  return { calls: Number(row?.calls ?? 0), costUsdMicro: String(BigInt(row?.cost ?? 0)) };
}

/** Calls and summed cost billed to `billedTo` ("castle:<id>" | "agent:<id>" | "team"), today (UTC) and all time. */
export function zgUsage(billedTo: string): ZgUsage {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  return { ...usageSince(billedTo), today: usageSince(billedTo, midnight.toISOString()) };
}
