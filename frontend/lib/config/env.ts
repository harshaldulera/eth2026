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
  FREE_SIEGES_PER_DAY: z.coerce.number().int().default(1),

  FEE_SPLIT_CASTELLAN_BPS: z.coerce.number().int().default(8000),
  FEE_SPLIT_POT_BPS: z.coerce.number().int().default(1500),
  FEE_SPLIT_ARENA_BPS: z.coerce.number().int().default(500),

  /** Server-side ceilings for POST /api/agents (tinybars): nobody can make the operator fund more. */
  AGENT_MAX_BUDGET: z.coerce.number().int().positive().default(20 * 100_000_000),
  AGENT_MAX_COUNT: z.coerce.number().int().positive().default(25),
});

const schema = base.superRefine((e, ctx) => {
  // Real money: the public dev key (which /api/config used to advertise) must never authorise approvals.
  if (e.CHAIN_MODE === "testnet" && (e.OWNER_SECRET === DEFAULT_OWNER_SECRET || e.OWNER_SECRET.length < MIN_TESTNET_OWNER_SECRET)) {
    ctx.addIssue({
      code: "custom",
      path: ["OWNER_SECRET"],
      message: `CHAIN_MODE=testnet needs OWNER_SECRET set to a private value of at least ${MIN_TESTNET_OWNER_SECRET} characters (not the dev default).`,
    });
  }
});

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
