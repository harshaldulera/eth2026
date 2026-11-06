/**
 * The venue path: develop in stub mode, then flip the same DB to CHAIN_MODE=testnet and re-seed.
 * Seed must replace every piece of stub chain state (vault ids, HCS topics, castellans, the demo
 * agent), and the worker's startup check must flag a DB that still holds it. Chain calls are mocked.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
process.env.SIEGE_FAST = "1";
import { eq } from "drizzle-orm";
import { resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";

const VAULT = "0x00000000000000000000000000000000005E1E02";

const vaultMock = vi.hoisted(() => {
  let id = 100;
  return { createVault: vi.fn(async () => ({ txHash: `0x${"cd".repeat(32)}`, vaultId: BigInt(++id), pot: BigInt(0), fee: BigInt(0), deadline: BigInt(0) })) };
});
vi.mock("@/lib/chain/vault", async (orig) => ({ ...(await orig<typeof import("@/lib/chain/vault")>()), ...vaultMock }));
const hcsMock = vi.hoisted(() => {
  let n = 5000;
  return { createTopic: vi.fn(async () => ({ topicId: `0.0.${++n}`, txId: `0.0.900@1762400000.000000${n}` })) };
});
vi.mock("@/lib/chain/hcs", async (orig) => ({ ...(await orig<typeof import("@/lib/chain/hcs")>()), ...hcsMock }));
vi.mock("@/lib/chain/mirror", async (orig) => ({
  ...(await orig<typeof import("@/lib/chain/mirror")>()),
  accountEvmAddress: vi.fn(async () => "0x0000000000000000000000000000000000000384"),
}));
vi.mock("@/lib/pay/hedera", async (orig) => ({
  ...(await orig<typeof import("@/lib/pay/hedera")>()),
  mirrorEvmAddress: vi.fn(async () => "0x00000000000000000000000000000000000003e8"),
}));

const { seed } = await import("./seed");
const { chainStateProblems } = await import("@/lib/chain");

function useTestnet() {
  Object.assign(process.env, {
    CHAIN_MODE: "testnet",
    OWNER_SECRET: "test-owner-secret-0123",
    HEDERA_OPERATOR_ID: "0.0.900",
    VAULT_ADDRESS: VAULT,
    RAIDER_ACCOUNT_MODE: "shared",
    RAIDER_OPERATOR_ID: "0.0.1000",
    RAIDER_OPERATOR_KEY: "0x" + "11".repeat(32),
  });
  resetEnv();
}
const KEYS = ["CHAIN_MODE", "OWNER_SECRET", "HEDERA_OPERATOR_ID", "VAULT_ADDRESS", "RAIDER_ACCOUNT_MODE", "RAIDER_OPERATOR_ID", "RAIDER_OPERATOR_KEY"];

beforeEach(() => {
  for (const k of KEYS) delete process.env[k];
  process.env.CHAIN_MODE = "stub";
  process.env.DATABASE_URL = ":memory:";
  resetEnv();
  freshFixtureDb();
  db().delete(schema.castles).run();
  vaultMock.createVault.mockClear();
  hcsMock.createTopic.mockClear();
});

afterAll(() => {
  for (const k of KEYS) delete process.env[k];
  resetEnv();
});

describe("seed after flipping a stub DB to testnet", () => {
  it("recreates vaults, topics, castellans and the demo agent; the worker check passes only afterwards", async () => {
    const stub = await seed({ quiet: true });
    expect(stub.castles.every((c) => c.topicId?.startsWith("0.0.stub-"))).toBe(true);
    expect(stub.agent?.accountId).toMatch(/^0\.0\.stub-agent-/);

    useTestnet();
    expect(chainStateProblems().length).toBeGreaterThanOrEqual(5 * 3); // vault, topic, owner per castle (+ agent)

    const real = await seed({ quiet: true });
    expect(vaultMock.createVault).toHaveBeenCalledTimes(5);
    expect(hcsMock.createTopic).toHaveBeenCalledTimes(5);
    const rows = db().select().from(schema.castles).all();
    for (const c of rows) {
      expect(c.vaultAddress).toBe(VAULT.toLowerCase());
      expect(c.vaultId).toBeGreaterThan(100);
      expect(c.topicId).toMatch(/^0\.0\.\d+$/);
      expect(c.owner).toBe("0.0.900");
      expect(c.status).toBe("open");
    }
    expect(real.agent).toMatchObject({ name: "Night Sapper", accountId: "0.0.1000" });
    const retired = db().select().from(schema.raiderAgents).where(eq(schema.raiderAgents.name, "Night Sapper (stub)")).get();
    expect(retired?.status).toBe("stopped");
    expect(chainStateProblems()).toEqual([]);

    // idempotent on testnet, and a redeployed vault (new VAULT_ADDRESS) is noticed
    await seed({ quiet: true });
    expect(vaultMock.createVault).toHaveBeenCalledTimes(5);
    process.env.VAULT_ADDRESS = "0x00000000000000000000000000000000005E1E03";
    resetEnv();
    expect(chainStateProblems().filter((p) => p.includes("vault #"))).toHaveLength(5);
    await seed({ quiet: true });
    expect(vaultMock.createVault).toHaveBeenCalledTimes(10);
    expect(chainStateProblems()).toEqual([]);
  });
});
