import { zgConfig } from "./config";

/** Who pays for a 0G call: the team key, or a signed-in iAI user's own key (their daily credits). */
export type Billing = { kind: "team" } | { kind: "user"; userId: string; apiKey: string };

/** Minimal OpenAI-compatible chat types (only what we use). */
export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  tool_choice?: "auto" | "none" | "required";
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" };
}

export interface ChatResult {
  message: { content: string | null; tool_calls?: OpenAIToolCall[] };
  finishReason: string;
  requestId: string;
  /** Chat id for independent TEE-signature verification (ZG-Res-Key header, body id fallback). */
  chatId: string;
  /** Provider address — looks up teeSignerAddress in 0G's on-chain Service contract. */
  provider?: string;
  costUsdMicro?: string;
  /** Router's check of the provider's TEE signature: true / false / undefined (not requested). */
  teeVerified?: boolean;
  raw: unknown;
}

export class ZgError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string,
  ) {
    super(message);
  }
}

function authKey(billing: Billing): string {
  return billing.kind === "user" ? billing.apiKey : zgConfig.apiKey;
}

function headers(billing: Billing): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${authKey(billing)}`,
  };
  if (zgConfig.trustMode) h["X-0G-Provider-Trust-Mode"] = zgConfig.trustMode;
  return h;
}

/** One chat completion against the 0G router. Never logs the request body (it contains secret orders). */
export async function chat(req: ChatRequest, billing: Billing = { kind: "team" }): Promise<ChatResult> {
  const body: Record<string, unknown> = { ...req };
  if (zgConfig.verifyTee) body.verify_tee = true;

  const res = await fetch(`${zgConfig.baseUrl}/chat/completions`, {
    method: "POST",
    headers: headers(billing),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new ZgError(`0G router ${res.status}`, res.status, text.slice(0, 500));

  const json = JSON.parse(text);
  const trace = json.x_0g_trace ?? {};
  const choice = json.choices?.[0];
  if (!choice) throw new ZgError("0G router returned no choices", 502, text.slice(0, 500));

  return {
    message: { content: choice.message?.content ?? null, tool_calls: choice.message?.tool_calls },
    finishReason: choice.finish_reason ?? "",
    requestId: trace.request_id ?? res.headers.get("x-request-id") ?? json.id ?? "",
    chatId: res.headers.get("zg-res-key") ?? json.id ?? "",
    provider: trace.provider,
    // Only the micro-USD integer field; billing.total_cost is a different unit/format.
    costUsdMicro: /^\d+$/.test(String(trace.billing?.total_cost_usd_micro ?? "")) ? String(trace.billing.total_cost_usd_micro) : undefined,
    teeVerified: trace.tee_verified ?? undefined,
    raw: json,
  };
}

export interface ImageResult {
  url?: string;
  b64?: string;
  requestId: string;
  raw: unknown;
}

/** Text-to-image (OpenAI images format). Used for agent avatars. */
export async function image(prompt: string, billing: Billing = { kind: "team" }, size = "1024x1024"): Promise<ImageResult> {
  const res = await fetch(`${zgConfig.baseUrl}/images/generations`, {
    method: "POST",
    headers: headers(billing),
    body: JSON.stringify({ model: zgConfig.imageModel, prompt, n: 1, size }),
  });
  const text = await res.text();
  if (!res.ok) throw new ZgError(`0G image ${res.status}`, res.status, text.slice(0, 500));
  const json = JSON.parse(text);
  const d = json.data?.[0] ?? {};
  return { url: d.url, b64: d.b64_json, requestId: json.x_0g_trace?.request_id ?? json.id ?? "", raw: json };
}
