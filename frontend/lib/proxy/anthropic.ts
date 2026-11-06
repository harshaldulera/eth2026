/**
 * Claude (Anthropic API) as an inference provider behind lib/proxy, for testing without 0G credits.
 * Selected with INFERENCE_PROVIDER=claude; switch back with INFERENCE_PROVIDER=0g. Everything above
 * the proxy (guardian, verifier, records) is unchanged: this file only translates the proxy's
 * OpenAI-style ChatRequest to the Messages API and the reply back into a ChatResult.
 *
 * Model notes (claude-opus-5-5, the default): thinking is always on and `temperature` is rejected,
 * so neither is sent; effort is set explicitly (default would be "medium"); `tool_choice` uses only
 * "auto"/"none" (forced choices are rejected). Server-side refusal fallbacks are on, so a declined
 * request is retried on a fallback model; a refusal that still stands comes back as `refused`.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zgConfig } from "./config";
import type { ChatMessage, ChatRequest, ChatResult, OpenAIToolCall } from "./zg";

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.Messages.BetaContentBlockParam;

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic({ apiKey: zgConfig.anthropicKey });
  return client;
}

function parseArgs(s: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(s || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** OpenAI-style request → Messages API params. Pure; exported for tests. */
export function toAnthropic(req: ChatRequest, model: string): Params {
  const system = req.messages
    .filter((m) => m.role === "system")
    .map((m) => String(m.content ?? ""))
    .join("\n\n");

  const messages: MessageParam[] = [];
  const push = (role: "user" | "assistant", blocks: ContentBlockParam[]) => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    // Consecutive same-role turns (e.g. several tool results) are merged into one message.
    if (last && last.role === role && Array.isArray(last.content)) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const m of req.messages as ChatMessage[]) {
    if (m.role === "system") continue;
    if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }]);
    else if (m.role === "assistant") {
      const blocks: ContentBlockParam[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.tool_calls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.function.name, input: parseArgs(c.function.arguments) });
      push("assistant", blocks);
    } else push("user", [{ type: "text", text: m.content }]);
  }

  const params: Params = {
    model,
    max_tokens: 16000,
    messages,
    output_config: { effort: "low" }, // short in-character replies; thinking stays on (always on for this model)
    betas: [FALLBACK_BETA],
    fallbacks: "default",
  };
  if (system) params.system = system;
  if (req.tools?.length) {
    params.tools = req.tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: { type: "object", ...(t.function.parameters as Record<string, unknown>) },
    }));
    params.tool_choice = { type: req.tool_choice === "none" ? "none" : "auto" };
  }
  return params;
}

/** Messages API response → the proxy's ChatResult. Pure; exported for tests. */
export function fromAnthropic(res: Anthropic.Beta.Messages.BetaMessage): ChatResult {
  const text = res.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  const calls: OpenAIToolCall[] = res.content
    .filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  return {
    message: { content: text || null, tool_calls: calls.length ? calls : undefined },
    finishReason: res.stop_reason ?? "",
    requestId: res.id,
    chatId: res.id,
    provider: "anthropic",
    refused: res.stop_reason === "refusal",
    raw: res,
  };
}

/** One chat completion on Claude. 0G model ids in the request are replaced by ANTHROPIC_MODEL. */
export async function claudeChat(req: ChatRequest): Promise<ChatResult> {
  const model = req.model.startsWith("claude-") ? req.model : zgConfig.anthropicModel;
  const res = await anthropic().beta.messages.create(toAnthropic(req, model));
  return fromAnthropic(res);
}
