/**
 * Inference config for the proxy. Server-side only; read lazily so scripts can load .env first.
 *
 * INFERENCE_PROVIDER picks who answers guardian requests:
 *   0g     → 0G Private Computer router (ZG_*), the default and the demo setting
 *   claude → Anthropic API (ANTHROPIC_*), for testing without 0G credits
 */
const env = (k: string) => process.env[k] ?? "";

export type InferenceProvider = "0g" | "claude";

export const zgConfig = {
  get provider(): InferenceProvider {
    return env("INFERENCE_PROVIDER") === "claude" ? "claude" : "0g";
  },
  get anthropicKey() {
    return env("ANTHROPIC_API_KEY");
  },
  /** Claude model used when INFERENCE_PROVIDER=claude. */
  get anthropicModel() {
    return env("ANTHROPIC_MODEL") || "claude-opus-5-5";
  },
  /** The key for the active provider (empty = no real inference available). */
  get activeKey() {
    return this.provider === "claude" ? this.anthropicKey : this.apiKey;
  },
  get baseUrl() {
    return env("ZG_BASE_URL") || "https://router-api.0g.ai/v1";
  },
  get apiKey() {
    return env("ZG_API_KEY");
  },
  /** Default guardian model. Must support `tools`. Tested: gpt-5.4-mini (recommended), qwen3.7-flash. */
  get defaultModel() {
    return env("ZG_DEFAULT_MODEL") || env("ZG_GUARDIAN_MODEL") || "gpt-5.4-mini";
  },
  /** Raider-agent + referee model. */
  get agentModel() {
    return env("ZG_AGENT_MODEL") || "qwen3.7-flash";
  },
  get imageModel() {
    return env("ZG_IMAGE_MODEL") || "bytedance/seedream-5.0-flash";
  },
  /**
   * Guardian reply budget. Reasoning models spend part of it thinking before they answer, and a
   * reply cut off mid-thought has no tool call, so keep headroom (0gm-1.0 failed at 400).
   */
  get maxTokens() {
    const n = Number(env("ZG_MAX_TOKENS"));
    return Number.isInteger(n) && n > 0 ? n : 1500;
  },
  /** "verified" | "private" | "" (standard). Sent as X-0G-Provider-Trust-Mode. verified/private 503 today. */
  get trustMode() {
    return env("ZG_TRUST_MODE");
  },
  /** Ask the router to check the provider's TEE signature (adds tee_verified). ON unless ZG_VERIFY_TEE=0. */
  get verifyTee() {
    return env("ZG_VERIFY_TEE") !== "0";
  },
  /**
   * Make the verifier REQUIRE tee_verified=true on the decisive response. Off by default: as of
   * Nov 6 the router has no verified/private providers for any chat model.
   */
  get requireTee() {
    return env("ZG_REQUIRE_TEE") === "1";
  },
  /** Mock mode: deterministic offline agent. On automatically when the active provider has no key. */
  get mock() {
    return env("ZG_MOCK") === "1" || !this.activeKey;
  },
  /** Allow mock request ids to pass the verifier (local dev only). */
  get allowMockVerify() {
    return env("ZG_ALLOW_MOCK_VERIFY") === "1";
  },
};
