import { z } from "zod";

/**
 * Server-only environment. Parsed once, lazily, so importing this file never crashes a build.
 * Stub mode (the default) needs none of the Hedera variables.
 */
/** The public dev owner key. Accepted ONLY in stub mode (env() refuses it when CHAIN_MODE=testnet). */
export const DEFAULT_OWNER_SECRET = "siege-demo-owner";
const MIN_TESTNET_OWNER_SECRET = 12;

const base = z.object({
  CHAIN_MODE: z.enum(["stub", "testnet"]).default("stub"),
  RAIDER_ACCOUNT_MODE: z.enum(["per-agent", "shared"]).default("per-agent"),
  DATABASE_URL: z.string().default("file:./data/siege.db"),
  APP_URL: z.string().default("http://localhost:3000"),
  OWNER_SECRET: z.string().default(DEFAULT_OWNER_SECRET),

  HEDERA_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  HEDERA_OPERATOR_ID: z.string().optional(),
  HEDERA_OPERATOR_KEY: z.string().optional(),
  HEDERA_RPC_URL: z.string().default("https://testnet.hashio.io/api"),
  /** EVM chain id override (e.g. 298 for a local solo node). Default: 296 testnet / 295 mainnet. */
  HEDERA_CHAIN_ID: z.coerce.number().int().positive().optional(),
  HEDERA_MIRROR_URL: z.string().default("https://testnet.mirrornode.hedera.com"),

  VAULT_ADDRESS: z.string().optional(),
  VERIFIER_ADDRESS: z.string().optional(),
  /** Worker only. Never read from app/ routes. */
  VERIFIER_KEY: z.string().optional(),

  FACILITATOR_URL: z.string().default("https://x402.org/facilitator"),
  X402_NETWORK: z.string().default("hedera:testnet"),
  X402_PAY_TO: z.string().optional(),
  X402_ASSET: z.string().default("0.0.0"),
  X402_ASSET_DECIMALS: z.coerce.number().int().default(8),
  X402_ASSET_SYMBOL: z.string().default("HBAR"),

  RAIDER_OPERATOR_ID: z.string().optional(),
  RAIDER_OPERATOR_KEY: z.string().optional(),
  /**
   * STUB ONLY. "1": POST /api/play/start may still pay a browser op from the arena's stub demo raider
   * (no unit given), for npm run demo / qa:op / record-demo. "0": every paid op must be paid from the
   * caller's own account (a unit or operator account + its rk_ key, or BYO x402). Unset: on in stub, off
   * on testnet. CHAIN_MODE=testnet refuses "1" at boot (superRefine below): on real money every op is
   * paid from the operator's own wallet, with no override. true/false, yes/no, on/off are read too.
   */
  DEMO_WALLET_OPS: z
    .string()
    .trim()
    .toLowerCase()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === "") return undefined;
      if (["1", "true", "yes", "on"].includes(v)) return true;
      if (["0", "false", "no", "off"].includes(v)) return false;
      ctx.addIssue({ code: "custom", message: `DEMO_WALLET_OPS must be 0 or 1 (got "${v.slice(0, 16)}").` });
      return z.NEVER;
    }),
  FREE_SIEGES_PER_DAY: z.coerce.number().int().default(1),

  FEE_SPLIT_CASTELLAN_BPS: z.coerce.number().int().default(8000),
  FEE_SPLIT_POT_BPS: z.coerce.number().int().default(1500),
  FEE_SPLIT_ARENA_BPS: z.coerce.number().int().default(500),

  /** Server-side ceilings for POST /api/agents (tinybars): nobody can make the operator fund more. */
  AGENT_MAX_BUDGET: z.coerce.number().int().positive().default(20 * 100_000_000),
  /** Max units that are not stopped (arena-funded and operator-funded together). */
  AGENT_MAX_COUNT: z.coerce.number().int().positive().default(100),

  // ─── Onboarding (plans/siege-onboarding-plan.md) ───
  /** Largest pot (tinybars) a published vault gets: pot = min(deposit received, this). Default 100 ℏ. */
  PUBLISH_MAX_POT: z.coerce.number().int().positive().default(100 * 100_000_000),
  /** POST /api/castles answers 429 once this many publish drafts await their deposit. */
  PUBLISH_MAX_OPEN_DRAFTS: z.coerce.number().int().positive().default(20),
  /** Minutes a deposit intent stays open (QR + memo panel countdown). */
  DEPOSIT_WINDOW_MIN: z.coerce.number().int().positive().default(45),
  /** Free recon ops per client IP per UTC day (venue Wi-Fi shares one IP). */
  FREE_RECON_PER_IP_PER_DAY: z.coerce.number().int().positive().default(25),
  /** Free recon ops across the whole arena per UTC day. */
  FREE_RECON_PER_DAY_TOTAL: z.coerce.number().int().positive().default(400),
  /** Smallest budget (tinybars) an operator-funded unit may be created with. Default 1 ℏ. */
  UNIT_MIN_BUDGET: z.coerce.number().int().positive().default(100_000_000),
  /**
   * Stub rehearsals only: hold a deposit in WAITING FOR DEPOSIT this long (ms) before it auto-confirms,
   * then walk SETTING UP k/n, so a stub recording shows the deposit beat. 0 (default) = confirm inline.
   */
  SIEGE_STUB_DEPOSIT_DELAY_MS: z.coerce.number().int().min(0).max(120_000).default(0),
  /**
   * Client IP for the free-recon / validate rate limits. TRUSTED_IP_HEADER names a header the edge sets
   * and clients cannot (e.g. cf-connecting-ip, x-real-ip on Vercel). Otherwise the x-forwarded-for entry
   * TRUSTED_PROXY_HOPS from the right (1 = the one your single proxy/tunnel appended).
   */
  TRUSTED_IP_HEADER: z.string().trim().toLowerCase().optional(),
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),
  /** 0G router base URL for connectZg (account/keys/models). Unset → ZG_BASE_URL → router-api.0g.ai/v1. */
  ZG_ROUTER_URL: z.string().optional(),
  /** Read only as ZG_ROUTER_URL's fallback here (lib/proxy/config.ts reads it for inference). */
  ZG_BASE_URL: z.string().optional(),
});

export const DEFAULT_ZG_ROUTER_URL = "https://router-api.0g.ai/v1";

const schema = base.superRefine((e, ctx) => {
  // Real money: the public dev key (which /api/config used to advertise) must never authorise approvals.
  if (e.CHAIN_MODE === "testnet" && (e.OWNER_SECRET === DEFAULT_OWNER_SECRET || e.OWNER_SECRET.length < MIN_TESTNET_OWNER_SECRET)) {
    ctx.addIssue({
      code: "custom",
      path: ["OWNER_SECRET"],
      message: `CHAIN_MODE=testnet needs OWNER_SECRET set to a private value of at least ${MIN_TESTNET_OWNER_SECRET} characters (not the dev default).`,
    });
  }
  // Real money: every op is paid from the operator's own wallet. The demo-wallet hatch is stub-only.
  if (e.CHAIN_MODE === "testnet" && e.DEMO_WALLET_OPS === true) {
    ctx.addIssue({
      code: "custom",
      path: ["DEMO_WALLET_OPS"],
      message: "DEMO_WALLET_OPS=1 is stub-only: on CHAIN_MODE=testnet every op is paid from the operator's own account. Remove it.",
    });
  }
}).transform((e) => ({ ...e, ZG_ROUTER_URL: (e.ZG_ROUTER_URL ?? e.ZG_BASE_URL ?? DEFAULT_ZG_ROUTER_URL).replace(/\/+$/, "") }));

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (!cached) {
    // An empty `KEY=` line in .env means "not set": treat it as unset so defaults apply (an empty
    // DATABASE_URL used to resolve to the project directory).
    const vars = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));
    const r = schema.safeParse(vars);
    if (!r.success) {
      throw new Error(`Invalid environment: ${r.error.issues.map((i) => `${i.path.join(".") || "env"}: ${i.message}`).join("; ")}`);
    }
    cached = r.data;
  }
  return cached;
}

/** For tests: re-read process.env. */
export function resetEnv() {
  cached = null;
}

/** Throw a readable error when a testnet-only variable is missing. */
export function required<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const v = env()[key];
  if (v === undefined || v === null || v === "") {
    throw new Error(`Missing env ${String(key)} (required when CHAIN_MODE=testnet). See frontend/.env.example.`);
  }
  return v as NonNullable<Env[K]>;
}

export const isStub = () => env().CHAIN_MODE === "stub";

/**
 * May a paid browser op still be paid from the arena's stub demo raider? Stub only: DEMO_WALLET_OPS wins
 * when set, unset = on. Testnet: always false (DEMO_WALLET_OPS=1 is refused at boot there), so every
 * paid op pays from the operator's own account.
 */
export const demoWalletOps = (): boolean => {
  if (!isStub()) return false;
  return env().DEMO_WALLET_OPS ?? true;
};
