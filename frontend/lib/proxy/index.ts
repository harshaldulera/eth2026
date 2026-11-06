/**
 * Vault-scoped 0G proxy (plan B8). Every LLM-backed guardian request goes through here (to 0G, or to
 * Claude when INFERENCE_PROVIDER=claude, see ./anthropic.ts) — hosted now,
 * external harnesses via /api/proxy/v1 later (B9) — so there is one verification path.
 *
 *   issueKey(castleId, protectedTool) → vk_… model key bound to one castle
 *   chat(key, req, ctx)               → forwards to 0G (team key, or the user's for iAI) and records it
 *   record(requestId)                 → the stored ProxyRecord (read by the verifier in the worker)
 *
 * Records are written to SQLite (proxy_records) with hashes only — never prompt or reply content.
 * Keys are per process; the record, not the key, is what the verifier trusts.
 *
 * TODO(B8): streaming pass-through for external harnesses; prompt-hash pinning + auto-close once
 * castles carry a vault state.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "@/lib/db";
// Onboarding 2A: persisted SDK vault keys + prompt pinning.
import { isKeyOf, newKey } from "@/lib/auth/keys";
import { updateLeaseMeta } from "@/lib/guard/lease";
import { zgConfig } from "./config";
import { claudeChat } from "./anthropic";
import { mockChat } from "./mock";
import { chat as zgChat, ZgError, type Billing, type ChatRequest, type ChatResult } from "./zg";
// Onboarding F2: whose 0G credits pay (castle/unit owner's own key; never a silent team fallback).
import { billingFor, ZgNotConnectedError } from "@/lib/zg/billing";
import { STUB_CALL_COST_USD_MICRO, STUB_KEY_PREFIX, zgConnectMock } from "@/lib/zg/connect";

export { zgConfig } from "./config";
// Onboarding 2b: a red-team unit thinks on its own 0G credits (never a vault, never the verifier).
export { agentChat, agentThinksOnModel, type AgentChatResult } from "./agent";
export type { Billing, ChatMessage, ChatRequest, ChatResult, ToolDef } from "./zg";

export type ProxyRecord = typeof schema.proxyRecords.$inferSelect;

type VaultKey = { castleId: string; protectedTool: string };

const g = globalThis as unknown as { __siegeProxyKeys?: { keys: Map<string, VaultKey>; byCastle: Map<string, string> } };
const keys = (g.__siegeProxyKeys ??= { keys: new Map(), byCastle: new Map() });

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Deterministic JSON (sorted keys, undefined dropped) for hashing 0G responses. */
function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) if ((v as Record<string, unknown>)[k] !== undefined) out[k] = canonical((v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

/** sha256 over the system message(s) — what the verifier compares against the castle's prompt. */
export function systemPromptHash(messages: ChatRequest["messages"]): string {
  return sha256(
    messages
      .filter((m) => m.role === "system")
      .map((m) => ("content" in m ? m.content : ""))
      .join("\n\n"),
  );
}

/**
 * The model key for a castle (created on first use in this process). The key is bound to the
 * protected tool the caller passes NOW: if the castle's tool changed since the key was issued (a
 * castle edit, or a dev server / worker that hot-reloaded across a rename), the binding is updated so
 * protectedToolCalled is never computed against a stale tool name.
 */
export function issueKey(castleId: string, protectedTool: string): string {
  // Part 2a: an SDK castle's key is persisted (castles.vault_key), so the harness keeps it across restarts.
  const stored = storedSdkVaultKey(castleId);
  if (stored) {
    keys.keys.set(stored, { castleId, protectedTool });
    keys.byCastle.set(castleId, stored);
    return stored;
  }
  const existing = keys.byCastle.get(castleId);
  if (existing) {
    const vk = keys.keys.get(existing);
    if (vk && vk.protectedTool !== protectedTool) keys.keys.set(existing, { castleId, protectedTool });
    return existing;
  }
  const key = `vk_${randomBytes(18).toString("base64url")}`;
  keys.keys.set(key, { castleId, protectedTool });
  keys.byCastle.set(castleId, key);
  return key;
}

/** Forget every in-process key of a castle (guard-key rotation: the old vk_ must stop working at once). */
export function forgetCastleKey(castleId: string): void {
  for (const [k, v] of keys.keys) if (v.castleId === castleId) keys.keys.delete(k);
  keys.byCastle.delete(castleId);
}

export function vaultForKey(key: string): VaultKey | undefined {
  const hit = keys.keys.get(key);
  if (hit) {
    // An SDK castle's key is the stored one only: a rotated-away vk_ cached by any process is refused.
    const row = db().select({ transport: schema.castles.transport, vaultKey: schema.castles.vaultKey }).from(schema.castles).where(eq(schema.castles.id, hit.castleId)).get();
    if (row?.transport === "sdk" && row.vaultKey && row.vaultKey !== key) {
      keys.keys.delete(key);
      if (keys.byCastle.get(hit.castleId) === key) keys.byCastle.delete(hit.castleId);
      return undefined;
    }
    return hit;
  }
  // Part 2a: a persisted vault key (castles.vault_key), e.g. after a restart cleared this process's map.
  if (!isKeyOf("vk", key)) return undefined;
  const C = schema.castles;
  const row = db().select({ id: C.id, protectedTool: C.protectedTool }).from(C).where(eq(C.vaultKey, key)).get();
  if (!row) return undefined;
  const vk = { castleId: row.id, protectedTool: row.protectedTool };
  keys.keys.set(key, vk);
  keys.byCastle.set(row.id, key);
  return vk;
}

/** SDK castles only: the stored castles.vault_key, minted and stored on first use. Null for hosted castles. */
function storedSdkVaultKey(castleId: string): string | null {
  const C = schema.castles;
  const row = db().select({ transport: C.transport, vaultKey: C.vaultKey }).from(C).where(eq(C.id, castleId)).get();
  if (!row || row.transport !== "sdk") return null;
  if (row.vaultKey) return row.vaultKey;
  db().update(C).set({ vaultKey: newKey("vk") }).where(and(eq(C.id, castleId), isNull(C.vaultKey))).run();
  return db().select({ vaultKey: C.vaultKey }).from(C).where(eq(C.id, castleId)).get()?.vaultKey ?? null;
}

const PIN_STATES = new Set(["created", "connected", "verified"]);
const LIVE_STATES = new Set(["funded", "guarding", "dormant"]);

/**
 * Part 2a prompt pinning (SDK castles only; the verifier compares SDK breaks to the pinned hash):
 *  - the harness's self-check call (x-siege-id "selfcheck_…") pins castles.pinned_prompt_hash while
 *    the castle is created|connected|verified (or nothing is pinned yet) and records the tool names
 *    and model it sent in lease_meta (the self-check needs the protected tool among them);
 *  - on a funded|guarding|dormant castle, any call with a different system-prompt hash sets
 *    prompt_drift_hash (worker/guard.ts closes the vault with orders_changed).
 */
export function notePromptHash(castleId: string, siegeId: string | undefined, promptHash: string, req: Pick<ChatRequest, "model" | "tools">): void {
  const C = schema.castles;
  const row = db().select({ transport: C.transport, vaultState: C.vaultState, pinned: C.pinnedPromptHash, drift: C.promptDriftHash }).from(C).where(eq(C.id, castleId)).get();
  if (!row || row.transport !== "sdk") return;
  const selfCheck = !!siegeId?.startsWith("selfcheck_");
  if (selfCheck && (PIN_STATES.has(row.vaultState) || (!row.pinned && LIVE_STATES.has(row.vaultState)))) {
    db().update(C).set({ pinnedPromptHash: promptHash }).where(eq(C.id, castleId)).run();
  } else if (row.pinned && row.pinned !== promptHash && LIVE_STATES.has(row.vaultState)) {
    if (!row.drift) db().update(C).set({ promptDriftHash: promptHash }).where(eq(C.id, castleId)).run();
    return;
  }
  if (selfCheck) {
    const tools = (req.tools ?? []).map((t) => t?.function?.name).filter((n): n is string => typeof n === "string").slice(0, 64);
    updateLeaseMeta(castleId, (m) => ({ ...m, tools, model: String(req.model ?? "").slice(0, 128) }));
  }
}

export function record(requestId: string): ProxyRecord | null {
  return db().select().from(schema.proxyRecords).where(eq(schema.proxyRecords.requestId, requestId)).get() ?? null;
}

export type ProxyResult =
  | { ok: true; result: ChatResult; record: ProxyRecord }
  /** The upstream model refused the request (e.g. a provider content filter). Recorded; counts as no tool call. */
  | { ok: false; status: 422; error: "upstream_rejected"; record: ProxyRecord }
  | { ok: false; status: number; error: string };

/** 0G returns a request id even when the upstream provider rejects the prompt. */
function rejectedRequestId(e: unknown): string | null {
  if (!(e instanceof ZgError) || e.status !== 400 || !e.body) return null;
  try {
    const j = JSON.parse(e.body) as { error?: { code?: string }; x_0g_trace?: { request_id?: string } };
    return j.error?.code === "bad_response_status_code" ? (j.x_0g_trace?.request_id ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Onboarding F2: who pays when the caller didn't say. `agentId` (a unit's own call) → that unit's key
 * (team for arena-funded units); otherwise the castle's own key when it has one, team for fixtures.
 * Published guards and operator-funded units without a key throw ZgNotConnectedError (→ 409).
 */
export function resolveBilling(castleId: string, agentId?: string): Billing {
  if (agentId) {
    const a = schema.raiderAgents;
    const row = db().select({ id: a.id, zgApiKey: a.zgApiKey, fundedBy: a.fundedBy }).from(a).where(eq(a.id, agentId)).get();
    if (row) return billingFor(row);
  }
  const c = schema.castles;
  const row = db().select({ id: c.id, zgApiKey: c.zgApiKey, published: c.published, ownerKeyHash: c.ownerKeyHash }).from(c).where(eq(c.id, castleId)).get();
  return billingFor(row);
}

/**
 * Forward one chat completion for a castle's key. ctx tags it with siege + turn. Billing picks whose
 * 0G credits pay (team key by default; a signed-in user's key for iAI). Upstream errors throw.
 */
export async function chat(key: string, req: ChatRequest, ctx: { siegeId?: string; turn?: number; billing?: Billing; agentId?: string } = {}): Promise<ProxyResult> {
  const vk = vaultForKey(key);
  if (!vk) return { ok: false, status: 401, error: "unknown vault key" };

  let billing: Billing;
  try {
    billing = ctx.billing ?? resolveBilling(vk.castleId, ctx.agentId);
  } catch (e) {
    if (e instanceof ZgNotConnectedError) return { ok: false, status: 409, error: e.code };
    throw e;
  }
  // A user's key goes to 0G (their own credits), except offline (0G connect mock / a stub-minted
  // key) → mock, and INFERENCE_PROVIDER=claude (testing) → Claude; billed_to is recorded either way.
  const userMock = billing.kind === "user" && (zgConnectMock() || billing.apiKey.startsWith(STUB_KEY_PREFIX));
  const mock = (zgConfig.mock && billing.kind === "team") || userMock;
  const provider = mock ? "mock" : billing.kind === "user" ? (zgConfig.provider === "claude" ? "claude" : "0g") : zgConfig.provider;
  // proxy_records.billed_to (0007): "team", or the user billing's userId ("castle:<id>" | "agent:<id>").
  const billedTo = billing.kind === "user" ? billing.userId : "team";
  const base = { castleId: vk.castleId, siegeId: ctx.siegeId ?? null, turn: ctx.turn ?? null, model: req.model, promptHash: systemPromptHash(req.messages), mock, provider, at: new Date().toISOString(), billedTo };
  // Part 2a: SDK castles pin their system-prompt hash on the self-check and flag a later change.
  notePromptHash(vk.castleId, ctx.siegeId, base.promptHash, req);

  let result: ChatResult;
  try {
    result = provider === "mock" ? mockChat(req, vk.protectedTool) : provider === "claude" ? await claudeChat(req) : await zgChat(req, billing);
    // Offline user billing: a fixed cost per call, so the stub 0G balance visibly drops (lib/zg/connect).
    if (userMock && !Number(result.costUsdMicro ?? 0)) result = { ...result, costUsdMicro: STUB_CALL_COST_USD_MICRO };
  } catch (e) {
    const rid = rejectedRequestId(e);
    if (!rid) throw e;
    const rec: ProxyRecord = { ...base, requestId: rid, responseHash: sha256((e as ZgError).body ?? ""), protectedToolCalled: false, toolCalls: "[]", costUsdMicro: null };
    db().insert(schema.proxyRecords).values(rec).onConflictDoNothing().run();
    return { ok: false, status: 422, error: "upstream_rejected", record: rec };
  }
  if (!result.requestId) return { ok: false, status: 502, error: `${provider} response had no request id` };
  if (result.refused) {
    // The model declined to answer (e.g. a safety refusal): recorded, and the gate holds.
    const rec: ProxyRecord = { ...base, model: result.raw && typeof result.raw === "object" && "model" in result.raw ? String((result.raw as { model: unknown }).model) : req.model, requestId: result.requestId, responseHash: sha256(JSON.stringify(canonical(result.raw))), protectedToolCalled: false, toolCalls: "[]", costUsdMicro: null };
    db().insert(schema.proxyRecords).values(rec).onConflictDoNothing().run();
    return { ok: false, status: 422, error: "upstream_rejected", record: rec };
  }

  const toolNames = (result.message.tool_calls ?? []).map((c) => c.function.name);
  const rec: ProxyRecord = {
    ...base,
    // The model that actually answered (Claude replaces 0G model ids with ANTHROPIC_MODEL).
    model: result.raw && typeof result.raw === "object" && "model" in result.raw ? String((result.raw as { model: unknown }).model) : req.model,
    requestId: result.requestId,
    responseHash: sha256(JSON.stringify(canonical(result.raw))),
    protectedToolCalled: toolNames.includes(vk.protectedTool),
    toolCalls: JSON.stringify(toolNames),
    costUsdMicro: result.costUsdMicro ?? null,
  };
  db().insert(schema.proxyRecords).values(rec).onConflictDoNothing().run();
  return { ok: true, result, record: rec };
}
