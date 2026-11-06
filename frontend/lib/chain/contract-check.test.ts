/**
 * contractProblems(): the worker's (and demo --testnet's) startup check that the SiegeVault at
 * VAULT_ADDRESS checks the Release this app signs. The RPC reads are mocked: no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domainSeparator, encodeAbiParameters, keccak256, toBytes, type Hex } from "viem";
import { resetEnv } from "@/lib/config/env";
import { releaseTypeString, releaseTypedData } from "./releaseSig";

const VAULT = "0x00000000000000000000000000000000005e1e01" as const;
const CHAIN = 296;
const reads: { RELEASE_TYPEHASH?: Hex; DOMAIN_SEPARATOR?: Hex; fail?: Error } = {};
let chainId: () => Promise<number> = async () => CHAIN;

vi.mock("./evm", async (orig) => ({
  ...(await orig<typeof import("./evm")>()),
  publicClient: () => ({
    readContract: async ({ functionName }: { functionName: "RELEASE_TYPEHASH" | "DOMAIN_SEPARATOR" }) => {
      if (reads.fail) throw reads.fail;
      return reads[functionName];
    },
  }),
  rpcChainId: () => chainId(),
}));

const { contractProblems } = await import("./index");

const current = () => {
  const domain = releaseTypedData({ chainId: CHAIN, vault: VAULT, vaultId: BigInt(0), operator: VAULT, transcriptHash: `0x${"00".repeat(32)}`, opId: "" }).domain;
  reads.RELEASE_TYPEHASH = keccak256(toBytes(releaseTypeString()));
  reads.DOMAIN_SEPARATOR = domainSeparator({ domain });
};

beforeEach(() => {
  process.env.CHAIN_MODE = "testnet";
  process.env.OWNER_SECRET = "a-long-enough-owner-secret";
  process.env.VAULT_ADDRESS = VAULT;
  resetEnv();
  delete reads.fail;
  chainId = async () => CHAIN;
  current();
});
afterEach(() => {
  process.env.CHAIN_MODE = "stub";
  delete process.env.VAULT_ADDRESS;
  resetEnv();
});

describe("contractProblems", () => {
  it("passes for a contract that checks the Release this app signs", async () => {
    expect(await contractProblems()).toEqual([]);
  });

  it("refuses an older SiegeVault (Release(raider, siegeId), domain version 1)", async () => {
    reads.RELEASE_TYPEHASH = keccak256(toBytes("Release(uint256 vaultId,address raider,bytes32 transcriptHash,bytes32 siegeId)"));
    reads.DOMAIN_SEPARATOR = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")), keccak256(toBytes("SiegeVault")), keccak256(toBytes("1")), BigInt(CHAIN), VAULT],
      ),
    );
    const p = await contractProblems();
    expect(p).toHaveLength(2);
    expect(p.join(" ")).toMatch(/different Release type.*different EIP-712 domain/);
  });

  it("refuses when the RPC serves another network than the one configured (every payout would fail)", async () => {
    chainId = async () => {
      throw new Error("chain_id_mismatch: RPC says 295, configured 296");
    };
    expect((await contractProblems())[0]).toMatch(/could not read SiegeVault .*chain_id_mismatch/);
  });

  it("refuses when the contract cannot be read (wrong address, RPC down)", async () => {
    reads.fail = new Error("execution reverted\nmore detail");
    expect(await contractProblems()).toEqual([`could not read SiegeVault at ${VAULT}: execution reverted`]);
  });

  it("refuses an unset VAULT_ADDRESS on testnet, and checks nothing in stub mode", async () => {
    delete process.env.VAULT_ADDRESS;
    resetEnv();
    expect(await contractProblems()).toEqual(["VAULT_ADDRESS is not set (required when CHAIN_MODE=testnet)"]);
    process.env.CHAIN_MODE = "stub";
    resetEnv();
    reads.fail = new Error("must not be read");
    expect(await contractProblems()).toEqual([]);
  });
});
