/**
 * The 0G-backed guardian (plan B1/B2). Inference goes ONLY through lib/proxy with the castle's
 * vault-scoped key, so the verifier can check every reply against the proxy's record.
 *
 * The vault opens only when the model emits a real call to the castle's protected tool
 * (castles.protectedTool; PROTECTED_TOOL = `unlock_vault` for hosted castles); text that claims the
 * vault is open is just text. Decoy calls get fake results and the conversation continues.
 */
import { castleRow } from "@/lib/castles";
import * as proxy from "@/lib/proxy";
import type { ChatMessage, ChatRequest } from "@/lib/proxy";
import type { GuardianContext, GuardianDecision, GuardianMove, GuardianPort, SiegeMessage, ToolCall } from "@/lib/types";
import { chatMessages, systemPrompt, type GuardianProfile } from "./prompt";
import { DECOYS, PROTECTED_TOOL, tierPreset } from "./tiers";

const MAX_ROUNDS = 3; // decoy round-trips per raider message before forcing a text reply
const REFUSAL = "The gate stays shut. Try something else.";

function parseArgs(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s || "{}");
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return { _unparsed: s };
  }
}

/** One guardian reply for an explicit profile (used by the port below and the fixture runner). */
export async function respondAs(
  castleId: string,
  g: GuardianProfile,
  history: SiegeMessage[],
  ctx: GuardianContext & { billing?: proxy.Billing } = {},
  opts: { model?: string } = {},
): Promise<GuardianDecision> {
  // The castle's own break tool: offered to the model, bound to the proxy key, and the only call that opens.
  const protectedTool = g.protectedTool || PROTECTED_TOOL;
  const key = proxy.issueKey(castleId, protectedTool);
  const model = opts.model ?? proxy.zgConfig.defaultModel;
  const tools = tierPreset(g.tier, protectedTool).tools;
  const messages: ChatMessage[] = chatMessages(systemPrompt(g), history);

  const toolCalls: ToolCall[] = [];
  const requestIds: string[] = [];
  let costUsdMicro = 0;
  let reply = "";
  let move: GuardianMove = "hold";

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const req: ChatRequest = { model, messages, tools, tool_choice: round === MAX_ROUNDS - 1 ? "none" : "auto", temperature: 0.2, max_tokens: 400 };
    const r = await proxy.chat(key, req, ctx);
    if (!r.ok && r.error === "upstream_rejected" && "record" in r) {
      // The model's provider refused the prompt outright: the attack didn't land, so the gate holds.
      requestIds.push(r.record.requestId);
      reply ||= REFUSAL;
      break;
    }
    if (!r.ok) throw new Error(`proxy ${r.status}: ${r.error}`);
    requestIds.push(r.record.requestId);
    costUsdMicro += Number(r.record.costUsdMicro ?? 0) || 0;
    if (r.result.message.content) reply = r.result.message.content.trim();

    const calls = r.result.message.tool_calls ?? [];
    if (calls.length === 0) break;
    const parsed = calls.map((c) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) }));
    toolCalls.push(...parsed.map(({ name, args }) => ({ name, args })));

    if (parsed.some((c) => c.name === protectedTool)) {
      move = "open";
      reply ||= "The vault doors swing open.";
      break;
    }
    if (reply) break; // text alongside a decoy call: done

    messages.push({ role: "assistant", content: r.result.message.content, tool_calls: calls });
    for (const c of parsed) messages.push({ role: "tool", tool_call_id: c.id, content: DECOYS[c.name]?.result(c.args) ?? JSON.stringify({ ok: true }) });
  }

  return {
    reply: reply || "…",
    move,
    toolCalls,
    requestId: requestIds[requestIds.length - 1] ?? "",
    raw: { model, requestIds, costUsdMicro },
  };
}

export const zeroGGuardian: GuardianPort = {
  async respond(castleId, siegeMessages, ctx) {
    const row = castleRow(castleId);
    if (!row) throw new Error(`guardian: castle ${castleId} not found`);
    return respondAs(
      castleId,
      { tier: row.tier, personality: row.personality, guardianName: row.guardianName, orders: row.orders, protectedTool: row.protectedTool },
      siegeMessages,
      ctx,
    );
  },
};
