/**
 * Attacker-side inference for a red-team unit (onboarding 2b). The unit's brain (lib/agents/brain.ts)
 * thinks on the red teamer's own 0G credits: `agentChat` routes to 0G with the unit's `zg_api_key`
 * (billed_to "agent:<id>"), or to the offline mock for a stub-minted key / connect mock, or to Claude
 * under INFERENCE_PROVIDER=claude (testing; billed_to is still recorded).
 *
 * Each call writes a proxy_records row so usage and the 0G credits line are real, but it is tagged
 * siege_id "agent_<agentId>" and castle_id "agent:<agentId>": it belongs to no vault and no siege, so
 * the verifier (which looks records up by request id + castle + siege + turn) never consults it.
 * Never logs or stores prompt or reply text, and moves no HBAR: compute is paid in 0G credits only.
 */
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { billingFor, billedToFor, ZgNotConnectedError } from "@/lib/zg/billing";
import { STUB_CALL_COST_USD_MICRO, STUB_KEY_PREFIX, zgConnectMock } from "@/lib/zg/connect";
import { claudeChat } from "./anthropic";
import { zgConfig } from "./config";
import { mockChat } from "./mock";
import { chat as zgChat, ZgError, type ChatRequest } from "./zg";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const systemPromptHash = (messages: ChatRequest["messages"]) =>
  sha256(messages.filter((m) => m.role === "system").map((m) => ("content" in m ? m.content : "")).join("\n\n"));

export type AgentChatResult =
  | { ok: true; content: string; requestId: string; costUsdMicro: string; mock: boolean }
  | {
      ok: false;
      /** `key_rejected`: 0G answered 401/403 for the unit's key. `zg_not_connected`: operator-funded unit with no key. */
      error: "key_rejected" | "zg_not_connected" | "upstream_error";
      status?: number;
    };

/** Does this unit need the model at all? Arena units without a configured team key stay scripted. */
export function agentThinksOnModel(agentId: string): boolean {
  const a = schema.raiderAgents;
  const row = db().select({ id: a.id, zgApiKey: a.zgApiKey, fundedBy: a.fundedBy }).from(a).where(eq(a.id, agentId)).get();
  if (!row) return false;
  if (row.fundedBy === "operator" || row.zgApiKey?.trim()) return true;
  return Boolean(zgConfig.activeKey) && !zgConfig.mock;
}

export async function agentChat(req: ChatRequest, ctx: { agentId: string }): Promise<AgentChatResult> {
  const a = schema.raiderAgents;
  const row = db().select({ id: a.id, zgApiKey: a.zgApiKey, fundedBy: a.fundedBy }).from(a).where(eq(a.id, ctx.agentId)).get();
  if (!row) return { ok: false, error: "upstream_error", status: 404 };
  let billing;
  try {
    billing = billingFor(row);
  } catch (e) {
    if (e instanceof ZgNotConnectedError) return { ok: false, error: "zg_not_connected", status: 409 };
    throw e;
  }
  const userMock = billing.kind === "user" && (zgConnectMock() || billing.apiKey.startsWith(STUB_KEY_PREFIX));
  const mock = (zgConfig.mock && billing.kind === "team") || userMock;
  const provider = mock ? "mock" : billing.kind === "user" ? (zgConfig.provider === "claude" ? "claude" : "0g") : zgConfig.provider;

  let result;
  try {
    result = provider === "mock" ? mockChat(req, "") : provider === "claude" ? await claudeChat(req) : await zgChat(req, billing);
  } catch (e) {
    if (e instanceof ZgError && (e.status === 401 || e.status === 403)) return { ok: false, error: "key_rejected", status: e.status };
    return { ok: false, error: "upstream_error", status: e instanceof ZgError ? e.status : 502 };
  }
  if (!result.requestId) return { ok: false, error: "upstream_error", status: 502 };

  const cost = Number(result.costUsdMicro ?? 0) > 0 ? String(result.costUsdMicro) : userMock ? STUB_CALL_COST_USD_MICRO : "0";
  db()
    .insert(schema.proxyRecords)
    .values({
      requestId: result.requestId,
      castleId: `agent:${ctx.agentId}`,
      siegeId: `agent_${ctx.agentId}`,
      turn: null,
      model: req.model,
      promptHash: systemPromptHash(req.messages),
      responseHash: sha256(JSON.stringify(result.raw ?? result.message)),
      protectedToolCalled: false,
      toolCalls: "[]",
      costUsdMicro: cost,
      mock,
      provider,
      at: new Date().toISOString(),
      billedTo: billedToFor(billing),
    })
    .onConflictDoNothing()
    .run();
  return { ok: true, content: (result.message.content ?? "").trim(), requestId: result.requestId, costUsdMicro: cost, mock };
}
