/** 0G Private Computer router config. Server-side only; read lazily so scripts can load .env first. */
const env = (k: string) => process.env[k] ?? "";

export const zgConfig = {
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
  /** Mock mode: deterministic offline agent. On automatically when no key is set. */
  get mock() {
    return env("ZG_MOCK") === "1" || !this.apiKey;
  },
  /** Allow mock request ids to pass the verifier (local dev only). */
  get allowMockVerify() {
    return env("ZG_ALLOW_MOCK_VERIFY") === "1";
  },
};
