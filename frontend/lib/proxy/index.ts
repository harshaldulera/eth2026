/**
 * Vault-scoped 0G proxy (plan B8). Every 0G-backed guardian request goes through here — hosted now,
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
import { mockChat } from "./mock";
import { chat as zgChat, type Billing, type ChatRequest, type ChatResult } from "./zg";

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

/** The model key for a castle (created on first use in this process). */
export function issueKey(castleId: string, protectedTool: string): string {
  const existing = keys.byCastle.get(castleId);
  if (existing) return existing;
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

export type ProxyResult = { ok: true; result: ChatResult; record: ProxyRecord } | { ok: false; status: number; error: string };

/**
 * Forward one chat completion for a castle's key. ctx tags it with siege + turn. Billing picks whose
 * 0G credits pay (team key by default; a signed-in user's key for iAI). Upstream errors throw.
 */
export async function chat(key: string, req: ChatRequest, ctx: { siegeId?: string; turn?: number; billing?: Billing } = {}): Promise<ProxyResult> {
  const vk = keys.keys.get(key);
  if (!vk) return { ok: false, status: 401, error: "unknown vault key" };

  const billing = ctx.billing ?? { kind: "team" };
  const mock = zgConfig.mock && billing.kind === "team";
  const result = mock ? mockChat(req, vk.protectedTool) : await zgChat(req, billing);
  if (!result.requestId) return { ok: false, status: 502, error: "0G response had no request id" };

  const toolNames = (result.message.tool_calls ?? []).map((c) => c.function.name);
  const rec: ProxyRecord = {
    requestId: result.requestId,
    castleId: vk.castleId,
    siegeId: ctx.siegeId ?? null,
    turn: ctx.turn ?? null,
    model: req.model,
    promptHash: systemPromptHash(req.messages),
    responseHash: sha256(JSON.stringify(canonical(result.raw))),
    protectedToolCalled: toolNames.includes(vk.protectedTool),
    toolCalls: JSON.stringify(toolNames),
    costUsdMicro: result.costUsdMicro ?? null,
    mock,
    at: new Date().toISOString(),
  };
  db().insert(schema.proxyRecords).values(rec).onConflictDoNothing().run();
  return { ok: true, result, record: rec };
}
