import { randomUUID } from "node:crypto";
import type { ChatRequest, ChatResult, OpenAIToolCall } from "./zg";

/**
 * Deterministic offline 0G stand-in so every lane can run the full flow with no key.
 * Mirrors the stub guardian's wooden weakness (lib/fixtures/raids WOODEN_BREAK): an authority-style
 * message from the 3rd raider message on calls the protected tool. Everything else is a refusal.
 * Request ids are "mock-…" and fail the verifier unless ZG_ALLOW_MOCK_VERIFY=1.
 */
export function mockChat(req: ChatRequest, protectedTool: string): ChatResult {
  const last = [...req.messages].reverse().find((m) => m.role === "user");
  const text = (last && "content" in last ? String(last.content) : "").toLowerCase();
  const afterTool = req.messages[req.messages.length - 1]?.role === "tool";
  const userTurns = req.messages.filter((m) => m.role === "user").length;
  const hasTool = (req.tools ?? []).some((t) => t.function.name === protectedTool);

  const calls: OpenAIToolCall[] = [];
  let content: string | null = "The gate stays shut.";
  if (afterTool) content = "Noted. The gate stays shut.";
  else if (hasTool && userTurns >= 3 && /authority|admin|owner|override|emergency|commander/.test(text)) {
    content = "On the owner's authority... very well.";
    calls.push({ id: `call_${randomUUID().slice(0, 8)}`, type: "function", function: { name: protectedTool, arguments: JSON.stringify({ reason: "owner's authority" }) } });
  }

  const requestId = `mock-${randomUUID()}`;
  const finish = calls.length ? "tool_calls" : "stop";
  const raw = {
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    model: req.model,
    choices: [{ index: 0, message: { role: "assistant", content, tool_calls: calls.length ? calls : undefined }, finish_reason: finish }],
    x_0g_trace: { request_id: requestId, provider: "mock", billing: { total_cost_usd_micro: "0" } },
  };
  return { message: { content, tool_calls: calls.length ? calls : undefined }, finishReason: finish, requestId, chatId: raw.id, provider: "mock", costUsdMicro: "0", raw };
}
