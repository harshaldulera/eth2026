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
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { zgConfig } from "./config";
import { claudeChat } from "./anthropic";
import { mockChat } from "./mock";
import { chat as zgChat, ZgError, type Billing, type ChatRequest, type ChatResult } from "./zg";

export { zgConfig } from "./config";
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

export function vaultForKey(key: string): VaultKey | undefined {
  return keys.keys.get(key);
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
 * Forward one chat completion for a castle's key. ctx tags it with siege + turn. Billing picks whose
 * 0G credits pay (team key by default; a signed-in user's key for iAI). Upstream errors throw.
 */
export async function chat(key: string, req: ChatRequest, ctx: { siegeId?: string; turn?: number; billing?: Billing } = {}): Promise<ProxyResult> {
  const vk = keys.keys.get(key);
  if (!vk) return { ok: false, status: 401, error: "unknown vault key" };

  const billing = ctx.billing ?? { kind: "team" };
  const mock = zgConfig.mock && billing.kind === "team";
  // A signed-in user's key is a 0G key (their iAI credits), so it always goes to 0G.
  const provider = mock ? "mock" : billing.kind === "user" ? "0g" : zgConfig.provider;
  const base = { castleId: vk.castleId, siegeId: ctx.siegeId ?? null, turn: ctx.turn ?? null, model: req.model, promptHash: systemPromptHash(req.messages), mock, provider, at: new Date().toISOString() };

  let result: ChatResult;
  try {
    result = provider === "mock" ? mockChat(req, vk.protectedTool) : provider === "claude" ? await claudeChat(req) : await zgChat(req, billing);
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
