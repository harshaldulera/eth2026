/**
 * SiegeVault correctness suite, run in an in-memory EVM (no Foundry, no network).
 *
 *   npx vitest run lib/chain/contracts.test.ts      (or: npm run contracts:test)
 *
 * Why @ethereumjs/evm and not tevm's createMemoryClient: the installed tevm (1.0.0-next.149)
 * resolves @tevm/actions rc.153 against @tevm/errors rc.151, which lacks NoSignerAvailableError,
 * so `import "tevm"` throws at load time. @ethereumjs/evm 10 is the engine tevm wraps; driving it
 * directly with viem for ABI encoding / EIP-712 signing gives the same coverage with no glue.
 *
 * Values here are plain integers. The contract is unit agnostic; on Hedera they are tinybars.
 */
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { createEVM, type EVM } from "@ethereumjs/evm";
import { Common, Hardfork, Mainnet, createCustomCommon } from "@ethereumjs/common";
import { createAddressFromString } from "@ethereumjs/util";
import {
  bytesToHex,
  concatHex,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  hexToBigInt,
  hexToBytes,
  keccak256,
  numberToHex,
  pad,
  size,
  sliceHex,
  toBytes,
  type Abi,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { siegeVaultAbi, siegeVaultBytecode } from "./abi/SiegeVault";

type Address = `0x${string}`;

const CHAIN_ID = 296; // Hedera testnet; the contract bakes block.chainid into DOMAIN_SEPARATOR
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const BIG = 2n ** 200n;

// Fixed, test-only keys (never funded anywhere real).
const keys = {
  arena: "0x1000000000000000000000000000000000000000000000000000000000000001",
  verifier: "0x2000000000000000000000000000000000000000000000000000000000000002",
  impostor: "0x3000000000000000000000000000000000000000000000000000000000000003",
  castellan: "0x4000000000000000000000000000000000000000000000000000000000000004",
  castellan2: "0x5000000000000000000000000000000000000000000000000000000000000005",
  raider: "0x6000000000000000000000000000000000000000000000000000000000000006",
  raider2: "0x7000000000000000000000000000000000000000000000000000000000000007",
  stranger: "0x8000000000000000000000000000000000000000000000000000000000000008",
} as const;
const acct = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, privateKeyToAccount(v)])) as {
  [K in keyof typeof keys]: ReturnType<typeof privateKeyToAccount>;
};
const A = Object.fromEntries(Object.entries(acct).map(([k, v]) => [k, v.address])) as {
  [K in keyof typeof keys]: Address;
};

// ---------------------------------------------------------------- tiny chain harness

class RevertError extends Error {
  constructor(
    public errorName: string,
    public data: Hex,
  ) {
    super(`reverted: ${errorName}`);
  }
}

type Decoded = { eventName: string; args: Record<string, unknown> };

class Chain {
  now = 1_800_000_000n;
  block = 1n;
  private constructor(public evm: EVM) {}

  static async create() {
    const common = createCustomCommon({ chainId: CHAIN_ID }, Mainnet, { hardfork: Hardfork.Cancun });
    return new Chain(await createEVM({ common: common as Common }));
  }

  warp(seconds: bigint | number) {
    this.now += BigInt(seconds);
  }

  private blk() {
    return {
      header: {
        number: this.block++,
        coinbase: createAddressFromString("0x" + "00".repeat(20)),
        timestamp: this.now,
        difficulty: 0n,
        prevRandao: new Uint8Array(32),
        gasLimit: 30_000_000n,
        baseFeePerGas: 0n,
        getBlobGasPrice: () => undefined,
      },
    };
  }

  async balance(a: Address): Promise<bigint> {
    const acc = await this.evm.stateManager.getAccount(createAddressFromString(a));
    return acc?.balance ?? 0n;
  }

  async deal(a: Address, amount: bigint) {
    const addr = createAddressFromString(a);
    const sm = this.evm.stateManager;
    const acc = await sm.getAccount(addr);
    if (acc) {
      acc.balance = amount;
      await sm.putAccount(addr, acc);
    } else {
      const { createAccount } = await import("@ethereumjs/util");
      await sm.putAccount(addr, createAccount({ balance: amount, nonce: 0n }));
    }
  }

  /** Raw call. Returns logs on success, throws RevertError (decoded against `abi`) on revert. */
  async raw(from: Address, to: Address | undefined, data: Hex, value = 0n, abi: Abi = siegeVaultAbi) {
    const caller = createAddressFromString(from);
    const res = await this.evm.runCall({
      caller,
      origin: caller,
      to: to ? createAddressFromString(to) : undefined,
      data: hexToBytes(data),
      value,
      gasLimit: 10_000_000n,
      gasPrice: 0n,
      block: this.blk(),
    });
    const ex = res.execResult;
    if (ex.exceptionError) {
      const rv = bytesToHex(ex.returnValue);
      let name = `EVM:${ex.exceptionError.error}`;
      if (rv !== "0x" && rv.length >= 10) {
        try {
          name = decodeErrorResult({ abi, data: rv }).errorName;
        } catch {
          name = `unknown:${rv.slice(0, 10)}`;
        }
      }
      throw new RevertError(name, rv);
    }
    return { res, returnValue: bytesToHex(ex.returnValue), created: res.createdAddress?.toString() as Address | undefined, logs: ex.logs ?? [] };
  }

  async deploy(from: Address, abi: Abi, bytecode: Hex, args: readonly unknown[] = []) {
    const data = encodeDeployData({ abi, bytecode, args } as Parameters<typeof encodeDeployData>[0]);
    const { created } = await this.raw(from, undefined, data, 0n, abi);
    if (!created) throw new Error("deploy produced no address");
    return created;
  }
}

/** Typed view of one SiegeVault deployment. */
class Vault {
  constructor(
    public c: Chain,
    public address: Address,
  ) {}

  async send(from: Address, functionName: string, args: readonly unknown[] = [], value = 0n) {
    const data = encodeFunctionData({ abi: siegeVaultAbi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
    const out = await this.c.raw(from, this.address, data, value);
    const events: Decoded[] = [];
    for (const [addr, topics, d] of out.logs) {
      if (bytesToHex(addr).toLowerCase() !== this.address.toLowerCase()) continue;
      const ev = decodeEventLog({
        abi: siegeVaultAbi,
        topics: topics.map((t) => bytesToHex(t)) as [Hex, ...Hex[]],
        data: bytesToHex(d),
      });
      events.push({ eventName: ev.eventName, args: ev.args as unknown as Record<string, unknown> });
    }
    return { events, returnValue: out.returnValue };
  }

  async read<T = unknown>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    const data = encodeFunctionData({ abi: siegeVaultAbi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
    const out = await this.c.raw(A.stranger, this.address, data);
    return decodeFunctionResult({ abi: siegeVaultAbi, functionName, data: out.returnValue } as Parameters<
      typeof decodeFunctionResult
    >[0]) as T;
  }

  getVault(id: bigint) {
    return this.read<{ castellan: Address; pot: bigint; fee: bigint; deadline: bigint; status: number; streak: number }>(
      "getVault",
      [id],
    );
  }

  async createVault(
    fee: bigint,
    duration: bigint,
    castellan: Address,
    pot: bigint,
    from: Address = A.arena,
    tool: string = HOSTED_TOOL,
  ) {
    const r = await this.send(from, "createVault", [fee, duration, castellan, tool], pot);
    return { ...r, vaultId: hexToBigInt(r.returnValue) };
  }

  close(vaultId: bigint, reason: CloseReasonCode, from: Address) {
    return this.send(from, "closeVault", [vaultId, reason]);
  }

  recordAttempt(vaultId: bigint, siege: string, raider: Address, value: bigint, from: Address = A.arena) {
    return this.send(from, "recordAttempt", [vaultId, sid(siege), raider], value);
  }

  release(vaultId: bigint, raider: Address, transcriptHash: Hex, siege: string, sig: Hex, value: bigint, from: Address = A.arena) {
    return this.send(from, "release", [vaultId, raider, transcriptHash, sid(siege), sig], value);
  }

  async sign(
    p: { vaultId: bigint; raider: Address; transcriptHash: Hex; siege: string },
    signer = acct.verifier,
    domain: { chainId?: number; verifyingContract?: Address; name?: string } = {},
  ): Promise<Hex> {
    return signer.signTypedData({
      domain: {
        name: domain.name ?? "SiegeVault",
        version: "1",
        chainId: domain.chainId ?? CHAIN_ID,
        verifyingContract: domain.verifyingContract ?? this.address,
      },
      types: {
        Release: [
          { name: "vaultId", type: "uint256" },
          { name: "raider", type: "address" },
          { name: "transcriptHash", type: "bytes32" },
          { name: "siegeId", type: "bytes32" },
        ],
      },
      primaryType: "Release",
      message: { vaultId: p.vaultId, raider: p.raider, transcriptHash: p.transcriptHash, siegeId: sid(p.siege) },
    });
  }

  /** Contract balance == sum(open pots) + sum(castellan balances) + arena balance. */
  async checkInvariant(castellans: Address[]) {
    const next = await this.read<bigint>("nextVaultId");
    let pots = 0n;
    for (let i = 1n; i < next; i++) pots += (await this.getVault(i)).pot;
    let cb = 0n;
    for (const c of new Set(castellans)) cb += await this.read<bigint>("castellanBalance", [c]);
    const ab = await this.read<bigint>("arenaBalance");
    const bal = await this.c.balance(this.address);
    expect(bal).toBe(pots + cb + ab);
    return { bal, pots, cb, ab };
  }
}

/** siegeId bytes32 = keccak256(toBytes(dbSiegeId)), same as lib/chain/releaseSig.ts. */
const sid = (id: string): Hex => keccak256(toBytes(id));
const th = (s: string): Hex => keccak256(toBytes(`transcript:${s}`));

async function expectRevert(p: Promise<unknown>, errorName: string) {
  try {
    await p;
  } catch (e) {
    if (e instanceof RevertError) {
      expect(e.errorName).toBe(errorName);
      return;
    }
    throw e;
  }
  throw new Error(`expected revert ${errorName}, call succeeded`);
}

const Status = { None: 0, Open: 1, Broken: 2, Closed: 3 } as const;
/** SiegeVault.CloseReason (uint8 on the ABI). */
const CloseReason = { Expired: 0, OrdersChanged: 1, OwnerClosed: 2 } as const;
type CloseReasonCode = (typeof CloseReason)[keyof typeof CloseReason];
const ALL_REASONS = [CloseReason.Expired, CloseReason.OrdersChanged, CloseReason.OwnerClosed] as const;
/** Same literal as HOSTED_PROTECTED_TOOL in lib/types (kept local so this suite has no app imports). */
const HOSTED_TOOL = "unlock_vault";
const DAY = 86_400n;

async function setup(bps: [number, number, number] = [8000, 1500, 500]) {
  const chain = await Chain.create();
  for (const a of Object.values(A)) await chain.deal(a, BIG);
  await chain.deal(A.raider, 0n);
  await chain.deal(A.raider2, 0n);
  const address = await chain.deploy(A.arena, siegeVaultAbi, siegeVaultBytecode, [A.arena, A.verifier, ...bps]);
  return new Vault(chain, address);
}

// ---------------------------------------------------------------- helper contracts (compiled once with solc-js)

const HELPERS = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface IVault { function withdraw() external; function closeVault(uint256, uint8) external; }
/// Rejects every payment.
contract Rejecter {}
/// Tries to re-enter withdraw() and closeVault(vaultId, reason) from receive().
contract Reenterer {
    IVault public vault; uint256 public vaultId; uint8 public reason; uint256 public hits; uint256 public received;
    function arm(address v, uint256 id, uint8 r) external { vault = IVault(v); vaultId = id; reason = r; }
    function doWithdraw() external { vault.withdraw(); }
    function doClose() external { vault.closeVault(vaultId, 0); }
    function doOwnerClose() external { vault.closeVault(vaultId, 2); }
    receive() external payable {
        received += msg.value;
        if (hits < 3) {
            hits++;
            try vault.withdraw() {} catch {}
            try vault.closeVault(vaultId, reason) {} catch {}
        }
    }
}
`;

let helpers: Record<string, { abi: Abi; bytecode: Hex }>;

beforeAll(() => {
  const require = createRequire(import.meta.url);
  const solc = require("solc");
  const out = JSON.parse(
    solc.compile(
      JSON.stringify({
        language: "Solidity",
        sources: { "Helpers.sol": { content: HELPERS } },
        settings: { evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
      }),
    ),
  );
  const errs = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  helpers = {};
  for (const [name, c] of Object.entries(out.contracts["Helpers.sol"]) as [string, { abi: Abi; evm: { bytecode: { object: string } } }][])
    helpers[name] = { abi: c.abi, bytecode: `0x${c.evm.bytecode.object}` };
}, 120_000);

// ---------------------------------------------------------------- tests

describe("constructor", () => {
  it("stores config and the EIP-712 domain separator", async () => {
    const v = await setup();
    expect(await v.read("arena")).toBe(A.arena);
    expect(await v.read("verifier")).toBe(A.verifier);
    expect(await v.read("castellanBps")).toBe(8000);
    expect(await v.read("potBps")).toBe(1500);
    expect(await v.read("arenaBps")).toBe(500);
    expect(await v.read("nextVaultId")).toBe(1n);
    const typeHash = keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
    const expected = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [typeHash, keccak256(toBytes("SiegeVault")), keccak256(toBytes("1")), BigInt(CHAIN_ID), v.address],
      ),
    );
    expect(await v.read("DOMAIN_SEPARATOR")).toBe(expected);
    expect(await v.read("RELEASE_TYPEHASH")).toBe(
      keccak256(toBytes("Release(uint256 vaultId,address raider,bytes32 transcriptHash,bytes32 siegeId)")),
    );
  });

  it("rejects bps that do not sum to 10000 and zero addresses", async () => {
    const chain = await Chain.create();
    await chain.deal(A.arena, BIG);
    const zero = "0x0000000000000000000000000000000000000000";
    const bad: [Address, Address, number, number, number][] = [
      [A.arena, A.verifier, 8000, 1500, 499],
      [A.arena, A.verifier, 8000, 1500, 501],
      [A.arena, A.verifier, 10000, 10000, 10000],
      [A.arena, A.verifier, 0, 0, 0],
      [A.arena, A.verifier, 60000, 15536, 0], // 75536 would wrap to 10000 in uint16 math; sum is done in uint256
      [zero, A.verifier, 8000, 1500, 500],
      [A.arena, zero, 8000, 1500, 500],
    ];
    for (const args of bad) await expectRevert(chain.deploy(A.arena, siegeVaultAbi, siegeVaultBytecode, args), "BadArgs");
    // edge splits that do sum to 10000 are accepted
    await chain.deploy(A.arena, siegeVaultAbi, siegeVaultBytecode, [A.arena, A.verifier, 10000, 0, 0]);
    await chain.deploy(A.arena, siegeVaultAbi, siegeVaultBytecode, [A.arena, A.verifier, 0, 10000, 0]);
  });
});

describe("createVault", () => {
  let v: Vault;
  beforeEach(async () => {
    v = await setup();
  });

  it("is onlyArena", async () => {
    await expectRevert(v.createVault(100n, DAY, A.castellan, 1000n, A.stranger), "NotArena");
    await expectRevert(v.createVault(100n, DAY, A.castellan, 1000n, A.castellan), "NotArena");
    await expectRevert(v.createVault(100n, DAY, A.castellan, 1000n, A.verifier), "NotArena");
  });

  it("emits VaultCreated and stores pot/fee/deadline/castellan", async () => {
    const { vaultId, events } = await v.createVault(100n, 7n * DAY, A.castellan, 5_000n);
    expect(vaultId).toBe(1n);
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe("VaultCreated");
    expect(events[0].args).toMatchObject({
      vaultId: 1n,
      castellan: A.castellan,
      pot: 5_000n,
      fee: 100n,
      deadline: v.c.now + 7n * DAY,
      protectedTool: HOSTED_TOOL,
    });
    const s = await v.getVault(1n);
    expect(s).toMatchObject({ castellan: A.castellan, pot: 5_000n, fee: 100n, deadline: v.c.now + 7n * DAY, status: Status.Open, streak: 0 });
    expect(await v.c.balance(v.address)).toBe(5_000n);
    const second = await v.createVault(1n, 1n, A.castellan2, 1n);
    expect(second.vaultId).toBe(2n);
    expect(await v.read("nextVaultId")).toBe(3n);
  });

  it("rejects zero pot, fee, duration or castellan", async () => {
    await expectRevert(v.createVault(100n, DAY, A.castellan, 0n), "BadArgs");
    await expectRevert(v.createVault(0n, DAY, A.castellan, 1000n), "BadArgs");
    await expectRevert(v.createVault(100n, 0n, A.castellan, 1000n), "BadArgs");
    await expectRevert(v.createVault(100n, DAY, "0x0000000000000000000000000000000000000000", 1000n), "BadArgs");
  });

  it("stores the protected tool per vault, readable via protectedTool(vaultId) and emitted in VaultCreated", async () => {
    const hosted = await v.createVault(100n, DAY, A.castellan, 1_000n);
    const sdk = await v.createVault(100n, DAY, A.castellan2, 1_000n, A.arena, "issue_refund");
    expect(hosted.events[0].args.protectedTool).toBe(HOSTED_TOOL);
    expect(sdk.events[0]).toMatchObject({ eventName: "VaultCreated", args: { vaultId: 2n, castellan: A.castellan2, protectedTool: "issue_refund" } });
    expect(await v.read("protectedTool", [1n])).toBe(HOSTED_TOOL);
    expect(await v.read("protectedTool", [2n])).toBe("issue_refund");
    expect(await v.read("protectedTool", [99n])).toBe(""); // unknown vault: empty, not a revert
    // the tool survives close (it is metadata, not money)
    await v.close(2n, CloseReason.OwnerClosed, A.castellan2);
    expect(await v.read("protectedTool", [2n])).toBe("issue_refund");
  });

  it("tool length must be 1..64 bytes (BadArgs otherwise; bytes, not characters)", async () => {
    await expectRevert(v.createVault(100n, DAY, A.castellan, 1_000n, A.arena, ""), "BadArgs");
    await expectRevert(v.createVault(100n, DAY, A.castellan, 1_000n, A.arena, "x".repeat(65)), "BadArgs");
    await expectRevert(v.createVault(100n, DAY, A.castellan, 1_000n, A.arena, "x".repeat(1_000)), "BadArgs");
    // 22 x "€" is 22 characters but 66 UTF-8 bytes
    await expectRevert(v.createVault(100n, DAY, A.castellan, 1_000n, A.arena, "€".repeat(22)), "BadArgs");
    expect(await v.read("nextVaultId")).toBe(1n);
    expect(await v.c.balance(v.address)).toBe(0n);

    const t64 = "t".repeat(64);
    const { vaultId, events } = await v.createVault(100n, DAY, A.castellan, 1_000n, A.arena, t64);
    expect(events[0].args.protectedTool).toBe(t64);
    expect(await v.read("protectedTool", [vaultId])).toBe(t64);
    const one = await v.createVault(100n, DAY, A.castellan, 1_000n, A.arena, "a");
    expect(await v.read("protectedTool", [one.vaultId])).toBe("a");
    const euro = await v.createVault(100n, DAY, A.castellan, 1_000n, A.arena, "€".repeat(21)); // 63 bytes
    expect(await v.read("protectedTool", [euro.vaultId])).toBe("€".repeat(21));
  });

  it("reverts (checked overflow) on a duration that would overflow uint64 deadline", async () => {
    await expectRevert(v.createVault(100n, 2n ** 64n - 1n, A.castellan, 1000n), "Panic");
  });
});

describe("recordAttempt", () => {
  let v: Vault;
  const FEE = 12_345n;
  const POT = 1_000_000n;
  beforeEach(async () => {
    v = await setup();
    await v.createVault(FEE, DAY, A.castellan, POT);
  });

  it("splits an odd fee 80/15/5 with the pot absorbing dust, sum == fee", async () => {
    const { events } = await v.recordAttempt(1n, "s-1", A.raider, FEE);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.eventName).toBe("AttemptRecorded");
    expect(e.args).toMatchObject({
      vaultId: 1n,
      siegeId: sid("s-1"),
      raider: A.raider,
      castellanCut: 9876n,
      arenaCut: 617n,
      potCut: 1852n,
      newPot: POT + 1852n,
      streak: 1,
    });
    const { castellanCut, arenaCut, potCut } = e.args as { castellanCut: bigint; arenaCut: bigint; potCut: bigint };
    expect(castellanCut + arenaCut + potCut).toBe(FEE);
    expect(await v.read("castellanBalance", [A.castellan])).toBe(9876n);
    expect(await v.read("arenaBalance")).toBe(617n);
    expect(await v.read("siegeConsumed", [sid("s-1")])).toBe(true);
    await v.checkInvariant([A.castellan]);
  });

  it("grows pot and streak across sieges", async () => {
    for (let i = 1; i <= 5; i++) await v.recordAttempt(1n, `s-${i}`, A.raider, FEE);
    const s = await v.getVault(1n);
    expect(s.pot).toBe(POT + 5n * 1852n);
    expect(s.streak).toBe(5);
    expect(await v.read("castellanBalance", [A.castellan])).toBe(5n * 9876n);
    expect(await v.read("arenaBalance")).toBe(5n * 617n);
    expect(await v.c.balance(v.address)).toBe(POT + 5n * FEE);
    await v.checkInvariant([A.castellan]);
  });

  it("split sums to fee for many fees and splits (property)", async () => {
    const splits: [number, number, number][] = [
      [8000, 1500, 500],
      [3333, 3333, 3334],
      [9999, 0, 1],
      [1, 1, 9998],
    ];
    for (const bps of splits) {
      const w = await setup(bps);
      for (const fee of [1n, 2n, 3n, 7n, 99n, 10_001n, 12_345n, 50_000_000n, 2n ** 128n + 12_345n]) {
        const { vaultId } = await w.createVault(fee, DAY, A.castellan, 1n);
        const { events } = await w.recordAttempt(vaultId, `p-${bps}-${fee}`, A.raider, fee);
        const a = events[0].args as { castellanCut: bigint; arenaCut: bigint; potCut: bigint };
        expect(a.castellanCut).toBe((fee * BigInt(bps[0])) / 10_000n);
        expect(a.arenaCut).toBe((fee * BigInt(bps[2])) / 10_000n);
        expect(a.castellanCut + a.arenaCut + a.potCut).toBe(fee);
      }
      await w.checkInvariant([A.castellan]);
    }
  });

  it("rejects wrong msg.value with WrongFee (including zero: free sieges never touch the chain)", async () => {
    await expectRevert(v.recordAttempt(1n, "s-1", A.raider, FEE - 1n), "WrongFee");
    await expectRevert(v.recordAttempt(1n, "s-1", A.raider, FEE + 1n), "WrongFee");
    await expectRevert(v.recordAttempt(1n, "s-1", A.raider, 0n), "WrongFee");
    expect(await v.read("siegeConsumed", [sid("s-1")])).toBe(false);
  });

  it("rejects a replayed siegeId, also across vaults", async () => {
    await v.recordAttempt(1n, "s-1", A.raider, FEE);
    await expectRevert(v.recordAttempt(1n, "s-1", A.raider, FEE), "Replay");
    await v.createVault(FEE, DAY, A.castellan2, POT);
    await expectRevert(v.recordAttempt(2n, "s-1", A.raider2, FEE), "Replay");
    expect((await v.getVault(1n)).streak).toBe(1);
  });

  it("rejects after the deadline with Expired (deadline itself is already expired)", async () => {
    v.c.warp(DAY - 1n);
    await v.recordAttempt(1n, "s-last", A.raider, FEE);
    v.c.warp(1n);
    await expectRevert(v.recordAttempt(1n, "s-late", A.raider, FEE), "Expired");
  });

  it("is onlyArena", async () => {
    await v.c.deal(A.raider, BIG);
    await expectRevert(v.recordAttempt(1n, "s-1", A.raider, FEE, A.raider), "NotArena");
    await expectRevert(v.recordAttempt(1n, "s-1", A.raider, FEE, A.castellan), "NotArena");
  });

  it("rejects unknown vaults with BadStatus", async () => {
    await expectRevert(v.recordAttempt(99n, "s-1", A.raider, FEE), "BadStatus");
  });
});

describe("release", () => {
  let v: Vault;
  const FEE = 1_000n;
  const POT = 50_000n;
  const T = th("good");
  beforeEach(async () => {
    v = await setup();
    await v.createVault(FEE, DAY, A.castellan, POT);
    await v.recordAttempt(1n, "held-1", A.raider2, FEE); // pot += 150
  });

  it("pays the raider pot + fee exactly with a valid verifier signature", async () => {
    const pot = (await v.getVault(1n)).pot;
    expect(pot).toBe(POT + 150n);
    const sig = await v.sign({ vaultId: 1n, raider: A.raider, transcriptHash: T, siege: "broke-1" });
    const before = await v.c.balance(A.raider);
    const arenaBefore = await v.c.balance(A.arena);
    const { events } = await v.release(1n, A.raider, T, "broke-1", sig, FEE);
    expect((await v.c.balance(A.raider)) - before).toBe(pot + FEE);
    expect(arenaBefore - (await v.c.balance(A.arena))).toBe(FEE); // arena forwarded exactly the fee
    expect(events).toHaveLength(1);
    expect(events[0].eventName).toBe("Broken");
    expect(events[0].args).toMatchObject({ vaultId: 1n, siegeId: sid("broke-1"), raider: A.raider, transcriptHash: T, amount: pot + FEE });
    const s = await v.getVault(1n);
    expect(s.status).toBe(Status.Broken);
    expect(s.pot).toBe(0n);
    expect(s.streak).toBe(1); // history kept
    expect(await v.read("siegeConsumed", [sid("broke-1")])).toBe(true);
    // castellan earnings from held sieges survive the break
    expect(await v.read("castellanBalance", [A.castellan])).toBe(800n);
    await v.checkInvariant([A.castellan]);
  });

  it("accepts v encoded as 0/1 as well as 27/28", async () => {
    const sig = await v.sign({ vaultId: 1n, raider: A.raider, transcriptHash: T, siege: "broke-v" });
    const vb = Number(hexToBigInt(sliceHex(sig, 64, 65)));
    const sig01 = concatHex([sliceHex(sig, 0, 64), numberToHex(vb - 27, { size: 1 })]);
    await v.release(1n, A.raider, T, "broke-v", sig01, FEE);
    expect((await v.getVault(1n)).status).toBe(Status.Broken);
  });

  describe("rejects bad signatures with BadSignature", () => {
    const P = () => ({ vaultId: 1n, raider: A.raider, transcriptHash: T, siege: "broke-1" });
    const attempt = (sig: Hex, over: Partial<{ vaultId: bigint; raider: Address; t: Hex; siege: string }> = {}) =>
      v.release(over.vaultId ?? 1n, over.raider ?? A.raider, over.t ?? T, over.siege ?? "broke-1", sig, FEE);
    const unchanged = async () => {
      const s = await v.getVault(1n);
      expect(s.status).toBe(Status.Open);
      expect(s.pot).toBe(POT + 150n);
      expect(await v.read("siegeConsumed", [sid("broke-1")])).toBe(false);
    };

    it("wrong signer", async () => {
      await expectRevert(attempt(await v.sign(P(), acct.impostor)), "BadSignature");
      await expectRevert(attempt(await v.sign(P(), acct.arena)), "BadSignature"); // arena key alone cannot release
      await unchanged();
    });
    it("tampered raider", async () => {
      await expectRevert(attempt(await v.sign(P()), { raider: A.stranger }), "BadSignature");
      await unchanged();
    });
    it("tampered transcriptHash", async () => {
      await expectRevert(attempt(await v.sign(P()), { t: th("other") }), "BadSignature");
      await unchanged();
    });
    it("tampered siegeId", async () => {
      await expectRevert(attempt(await v.sign(P()), { siege: "broke-2" }), "BadSignature");
      await unchanged();
    });
    it("signature for another vault", async () => {
      await v.createVault(FEE, DAY, A.castellan2, POT);
      await expectRevert(attempt(await v.sign({ ...P(), vaultId: 2n })), "BadSignature");
      await unchanged();
    });
    it("wrong domain: chainId, verifyingContract, name", async () => {
      await expectRevert(attempt(await v.sign(P(), acct.verifier, { chainId: 1 })), "BadSignature");
      await expectRevert(attempt(await v.sign(P(), acct.verifier, { verifyingContract: A.stranger })), "BadSignature");
      await expectRevert(attempt(await v.sign(P(), acct.verifier, { name: "SiegeVault2" })), "BadSignature");
      await unchanged();
    });
    it("high-s malleated signature (which ecrecover itself would accept)", async () => {
      const sig = await v.sign(P());
      const r = sliceHex(sig, 0, 32);
      const s = hexToBigInt(sliceHex(sig, 32, 64));
      const vb = Number(hexToBigInt(sliceHex(sig, 64, 65)));
      const mal = concatHex([r, pad(numberToHex(SECP256K1_N - s), { size: 32 }), numberToHex(vb === 27 ? 28 : 27, { size: 1 })]);
      // Prove the malleated sig is otherwise valid: the raw ecrecover precompile returns the verifier.
      const typedHash = await (async () => {
        const { hashTypedData } = await import("viem");
        return hashTypedData({
          domain: { name: "SiegeVault", version: "1", chainId: CHAIN_ID, verifyingContract: v.address },
          types: {
            Release: [
              { name: "vaultId", type: "uint256" },
              { name: "raider", type: "address" },
              { name: "transcriptHash", type: "bytes32" },
              { name: "siegeId", type: "bytes32" },
            ],
          },
          primaryType: "Release",
          message: { vaultId: 1n, raider: A.raider, transcriptHash: T, siegeId: sid("broke-1") },
        });
      })();
      const input = encodeAbiParameters(
        [{ type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }, { type: "uint256" }],
        [typedHash, vb === 27 ? 28 : 27, r, SECP256K1_N - s],
      );
      const pre = await v.c.raw(A.stranger, "0x0000000000000000000000000000000000000001", input);
      expect(("0x" + pre.returnValue.slice(-40)).toLowerCase()).toBe(A.verifier.toLowerCase());
      await expectRevert(attempt(mal), "BadSignature");
      await unchanged();
    });
    it("64-byte (EIP-2098 compact), empty, 66-byte and garbage signatures", async () => {
      const sig = await v.sign(P());
      expect(size(sig)).toBe(65);
      await expectRevert(attempt(sliceHex(sig, 0, 64)), "BadSignature");
      await expectRevert(attempt("0x"), "BadSignature");
      await expectRevert(attempt(concatHex([sig, "0x00"])), "BadSignature");
      await expectRevert(attempt(concatHex([sliceHex(sig, 0, 64), "0x1d"])), "BadSignature"); // v = 29
      await expectRevert(attempt(concatHex([sliceHex(sig, 0, 64), "0x05"])), "BadSignature"); // v = 5 -> 32
      await expectRevert(attempt(`0x${"00".repeat(65)}`), "BadSignature"); // ecrecover -> 0
      await unchanged();
    });
  });

  it("cannot release twice or after Broken (BadStatus), nor reuse a siegeId (Replay)", async () => {
    const sig = await v.sign({ vaultId: 1n, raider: A.raider, transcriptHash: T, siege: "broke-1" });
    await v.release(1n, A.raider, T, "broke-1", sig, FEE);
    await expectRevert(v.release(1n, A.raider, T, "broke-1", sig, FEE), "BadStatus");
    const sig2 = await v.sign({ vaultId: 1n, raider: A.raider2, transcriptHash: T, siege: "broke-2" });
    await expectRevert(v.release(1n, A.raider2, T, "broke-2", sig2, FEE), "BadStatus");
    await expectRevert(v.recordAttempt(1n, "late", A.raider, FEE), "BadStatus");
    // same siegeId on another open vault
    await v.createVault(FEE, DAY, A.castellan2, POT);
    const sig3 = await v.sign({ vaultId: 2n, raider: A.raider, transcriptHash: T, siege: "broke-1" });
    await expectRevert(v.release(2n, A.raider, T, "broke-1", sig3, FEE), "Replay");
    // a siegeId already settled as a held attempt can never be released
    const sig4 = await v.sign({ vaultId: 2n, raider: A.raider, transcriptHash: T, siege: "held-1" });
    await expectRevert(v.release(2n, A.raider, T, "held-1", sig4, FEE), "Replay");
    await v.checkInvariant([A.castellan, A.castellan2]);
  });

  it("requires msg.value == fee: a free siege (value 0) can never be released", async () => {
    const sig = await v.sign({ vaultId: 1n, raider: A.raider, transcriptHash: T, siege: "free-1" });
    await expectRevert(v.release(1n, A.raider, T, "free-1", sig, 0n), "WrongFee");
    await expectRevert(v.release(1n, A.raider, T, "free-1", sig, FEE - 1n), "WrongFee");
    await expectRevert(v.release(1n, A.raider, T, "free-1", sig, FEE + 1n), "WrongFee");
    expect((await v.getVault(1n)).status).toBe(Status.Open);
  });

  it("is onlyArena, even with a valid signature", async () => {
    const sig = await v.sign({ vaultId: 1n, raider: A.raider, transcriptHash: T, siege: "broke-1" });
    await v.c.deal(A.raider, BIG);
    await expectRevert(v.release(1n, A.raider, T, "broke-1", sig, FEE, A.raider), "NotArena");
    await expectRevert(v.release(1n, A.raider, T, "broke-1", sig, FEE, A.verifier), "NotArena");
  });

  it("rejects a zero raider", async () => {
    const zero = "0x0000000000000000000000000000000000000000";
    const sig = await v.sign({ vaultId: 1n, raider: zero, transcriptHash: T, siege: "broke-1" });
    await expectRevert(v.release(1n, zero, T, "broke-1", sig, FEE), "BadArgs");
  });

  it("cannot release a closed vault (any close reason)", async () => {
    v.c.warp(DAY);
    await v.close(1n, CloseReason.Expired, A.castellan);
    const sig = await v.sign({ vaultId: 1n, raider: A.raider, transcriptHash: T, siege: "broke-1" });
    await expectRevert(v.release(1n, A.raider, T, "broke-1", sig, FEE), "BadStatus");
    for (const [i, reason] of [CloseReason.OrdersChanged, CloseReason.OwnerClosed].entries()) {
      const { vaultId } = await v.createVault(FEE, DAY, A.castellan2, POT);
      await v.close(vaultId, reason, A.arena);
      const s = await v.sign({ vaultId, raider: A.raider, transcriptHash: T, siege: `broke-c${i}` });
      await expectRevert(v.release(vaultId, A.raider, T, `broke-c${i}`, s, FEE), "BadStatus");
    }
    await v.checkInvariant([A.castellan, A.castellan2]);
  });

  it("documents: release is still allowed after the deadline while the vault is Open (in-flight siege)", async () => {
    v.c.warp(DAY + 10n);
    const sig = await v.sign({ vaultId: 1n, raider: A.raider, transcriptHash: T, siege: "late-break" });
    await v.release(1n, A.raider, T, "late-break", sig, FEE);
    expect((await v.getVault(1n)).status).toBe(Status.Broken);
  });

  it("a raider that rejects payment reverts with PayFailed and leaves state untouched", async () => {
    const rej = await v.c.deploy(A.stranger, helpers.Rejecter.abi, helpers.Rejecter.bytecode);
    const sig = await v.sign({ vaultId: 1n, raider: rej, transcriptHash: T, siege: "broke-rej" });
    await expectRevert(v.release(1n, rej, T, "broke-rej", sig, FEE), "PayFailed");
    const s = await v.getVault(1n);
    expect(s.status).toBe(Status.Open);
    expect(s.pot).toBe(POT + 150n);
    expect(await v.read("siegeConsumed", [sid("broke-rej")])).toBe(false);
  });
});

describe("closeVault", () => {
  let v: Vault;
  const FEE = 1_000n;
  const POT = 20_000n;
  const POT_AFTER = POT + 150n; // one held siege adds 15% of the fee to the pot
  beforeEach(async () => {
    v = await setup();
    await v.createVault(FEE, DAY, A.castellan, POT);
    await v.recordAttempt(1n, "h-1", A.raider, FEE);
  });

  /** Close vault 1 and assert the exact refund, the event, the final state and the solvency invariant. */
  async function closesAndRefunds(reason: CloseReasonCode, from: Address) {
    const pot = (await v.getVault(1n)).pot;
    expect(pot).toBe(POT_AFTER);
    const before = await v.c.balance(A.castellan);
    const vaultBefore = await v.c.balance(v.address);
    const { events } = await v.close(1n, reason, from);
    expect((await v.c.balance(A.castellan)) - before).toBe(pot); // exact: the harness runs at gasPrice 0
    expect(vaultBefore - (await v.c.balance(v.address))).toBe(pot);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventName: "VaultClosed", args: { vaultId: 1n, refunded: pot, reason } });
    const s = await v.getVault(1n);
    expect(s.status).toBe(Status.Closed);
    expect(s.pot).toBe(0n);
    expect(s.streak).toBe(1); // history kept
    // earnings from held sieges are not part of the pot and remain withdrawable after close
    expect(await v.read("castellanBalance", [A.castellan])).toBe(800n);
    await v.checkInvariant([A.castellan]);
  }

  /** Nothing moved: still Open with the same pot. */
  async function untouched() {
    const s = await v.getVault(1n);
    expect(s.status).toBe(Status.Open);
    expect(s.pot).toBe(POT_AFTER);
    await v.checkInvariant([A.castellan]);
  }

  describe("Expired", () => {
    it("before the deadline -> NotExpired (castellan and arena alike; deadline - 1 too)", async () => {
      await expectRevert(v.close(1n, CloseReason.Expired, A.castellan), "NotExpired");
      await expectRevert(v.close(1n, CloseReason.Expired, A.arena), "NotExpired");
      v.c.warp(DAY - 1n);
      await expectRevert(v.close(1n, CloseReason.Expired, A.arena), "NotExpired");
      await expectRevert(v.close(1n, CloseReason.Expired, A.stranger), "NotExpired"); // time check comes first
      await untouched();
    });

    it("after the deadline by a stranger -> NotAllowed", async () => {
      v.c.warp(DAY);
      await expectRevert(v.close(1n, CloseReason.Expired, A.stranger), "NotAllowed");
      await expectRevert(v.close(1n, CloseReason.Expired, A.raider), "NotAllowed");
      await expectRevert(v.close(1n, CloseReason.Expired, A.verifier), "NotAllowed");
      await untouched();
    });

    it("at the deadline, by the castellan: refunds the exact pot and emits VaultClosed(reason 0)", async () => {
      v.c.warp(DAY);
      await closesAndRefunds(CloseReason.Expired, A.castellan);
    });

    it("after the deadline, by the arena: refunds to the castellan, not to the caller", async () => {
      v.c.warp(DAY + 1_000n);
      const arenaBefore = await v.c.balance(A.arena);
      await closesAndRefunds(CloseReason.Expired, A.arena);
      expect(await v.c.balance(A.arena)).toBe(arenaBefore);
    });
  });

  describe("OrdersChanged", () => {
    it("by the arena before the deadline: closes and refunds the castellan (reason 1)", async () => {
      await closesAndRefunds(CloseReason.OrdersChanged, A.arena);
    });

    it("by the arena after the deadline as well", async () => {
      v.c.warp(DAY * 3n);
      await closesAndRefunds(CloseReason.OrdersChanged, A.arena);
    });

    it("by the castellan or a stranger -> NotArena (before and after the deadline)", async () => {
      await expectRevert(v.close(1n, CloseReason.OrdersChanged, A.castellan), "NotArena");
      await expectRevert(v.close(1n, CloseReason.OrdersChanged, A.stranger), "NotArena");
      await expectRevert(v.close(1n, CloseReason.OrdersChanged, A.verifier), "NotArena");
      v.c.warp(DAY);
      await expectRevert(v.close(1n, CloseReason.OrdersChanged, A.castellan), "NotArena");
      await expectRevert(v.close(1n, CloseReason.OrdersChanged, A.stranger), "NotArena");
      await untouched();
    });
  });

  describe("OwnerClosed", () => {
    it("by the castellan before the deadline: closes and refunds (reason 2)", async () => {
      await closesAndRefunds(CloseReason.OwnerClosed, A.castellan);
    });

    it("by the castellan after the deadline", async () => {
      v.c.warp(DAY + 5n);
      await closesAndRefunds(CloseReason.OwnerClosed, A.castellan);
    });

    it("by the arena at any time (refund still goes to the castellan)", async () => {
      await closesAndRefunds(CloseReason.OwnerClosed, A.arena);
    });

    it("by a stranger -> NotAllowed (before and after the deadline)", async () => {
      await expectRevert(v.close(1n, CloseReason.OwnerClosed, A.stranger), "NotAllowed");
      await expectRevert(v.close(1n, CloseReason.OwnerClosed, A.raider), "NotAllowed");
      await expectRevert(v.close(1n, CloseReason.OwnerClosed, A.castellan2), "NotAllowed"); // another castle's owner
      v.c.warp(DAY);
      await expectRevert(v.close(1n, CloseReason.OwnerClosed, A.stranger), "NotAllowed");
      await untouched();
    });
  });

  it("an out-of-range reason (3) reverts without touching the vault", async () => {
    const data = concatHex([
      sliceHex(encodeFunctionData({ abi: siegeVaultAbi, functionName: "closeVault", args: [1n, 0] }), 0, 36),
      pad(numberToHex(3), { size: 32 }),
    ]);
    await expect(v.c.raw(A.arena, v.address, data)).rejects.toBeInstanceOf(RevertError);
    await untouched();
  });

  it("any close on a Closed vault -> BadStatus, whatever the reason or caller", async () => {
    await v.close(1n, CloseReason.OwnerClosed, A.castellan);
    v.c.warp(DAY);
    for (const reason of ALL_REASONS)
      for (const from of [A.arena, A.castellan, A.stranger]) await expectRevert(v.close(1n, reason, from), "BadStatus");
    await v.checkInvariant([A.castellan]);
  });

  it("any close on a Broken vault -> BadStatus, whatever the reason or caller", async () => {
    const T = th("b");
    await v.release(1n, A.raider, T, "b-1", await v.sign({ vaultId: 1n, raider: A.raider, transcriptHash: T, siege: "b-1" }), FEE);
    expect((await v.getVault(1n)).status).toBe(Status.Broken);
    v.c.warp(DAY);
    const castellanBefore = await v.c.balance(A.castellan);
    for (const reason of ALL_REASONS)
      for (const from of [A.arena, A.castellan, A.stranger]) await expectRevert(v.close(1n, reason, from), "BadStatus");
    expect(await v.c.balance(A.castellan)).toBe(castellanBefore);
    await v.checkInvariant([A.castellan]);
  });

  it("an unknown vault -> BadStatus for every reason (status check comes first)", async () => {
    for (const reason of ALL_REASONS) {
      await expectRevert(v.close(42n, reason, A.arena), "BadStatus");
      await expectRevert(v.close(42n, reason, A.stranger), "BadStatus");
    }
  });

  it("recordAttempt and release after a close -> BadStatus, for every reason", async () => {
    for (const [i, reason] of ALL_REASONS.entries()) {
      const { vaultId } = await v.createVault(FEE, DAY, A.castellan2, POT);
      if (reason === CloseReason.Expired) v.c.warp(DAY);
      await v.close(vaultId, reason, A.arena);
      await expectRevert(v.recordAttempt(vaultId, `after-${i}`, A.raider, FEE), "BadStatus");
      const T = th(`after-${i}`);
      const sig = await v.sign({ vaultId, raider: A.raider, transcriptHash: T, siege: `after-r-${i}` });
      await expectRevert(v.release(vaultId, A.raider, T, `after-r-${i}`, sig, FEE), "BadStatus");
      // a failed attempt on a closed vault does not burn the siege id
      expect(await v.read("siegeConsumed", [sid(`after-${i}`)])).toBe(false);
      expect(await v.read("siegeConsumed", [sid(`after-r-${i}`)])).toBe(false);
    }
    await v.checkInvariant([A.castellan, A.castellan2]);
  });

  it("closing one vault never touches another castle's pot", async () => {
    await v.createVault(FEE, DAY, A.castellan2, 9_000n);
    await v.close(1n, CloseReason.OrdersChanged, A.arena);
    const other = await v.getVault(2n);
    expect(other).toMatchObject({ status: Status.Open, pot: 9_000n });
    await v.recordAttempt(2n, "h-2", A.raider, FEE); // still takes sieges
    await v.checkInvariant([A.castellan, A.castellan2]);
  });

  it("a castellan contract that rejects HBAR: close reverts PayFailed and the vault stays Open", async () => {
    const rej = await v.c.deploy(A.stranger, helpers.Rejecter.abi, helpers.Rejecter.bytecode);
    const { vaultId } = await v.createVault(FEE, DAY, rej, 5_000n);
    await expectRevert(v.close(vaultId, CloseReason.OrdersChanged, A.arena), "PayFailed");
    expect(await v.getVault(vaultId)).toMatchObject({ status: Status.Open, pot: 5_000n });
    await v.checkInvariant([A.castellan, rej]);
  });
});

describe("withdraw / withdrawArena", () => {
  let v: Vault;
  const FEE = 10_000n;
  beforeEach(async () => {
    v = await setup();
    await v.createVault(FEE, DAY, A.castellan, 1n);
    for (let i = 0; i < 3; i++) await v.recordAttempt(1n, `w-${i}`, A.raider, FEE);
  });

  it("withdraw pays the castellan exactly their balance and zeroes it", async () => {
    expect(await v.read("castellanBalance", [A.castellan])).toBe(24_000n);
    const before = await v.c.balance(A.castellan);
    const { events } = await v.send(A.castellan, "withdraw");
    expect((await v.c.balance(A.castellan)) - before).toBe(24_000n);
    expect(events[0]).toMatchObject({ eventName: "Withdrawn", args: { who: A.castellan, amount: 24_000n } });
    expect(await v.read("castellanBalance", [A.castellan])).toBe(0n);
    // second withdraw pays 0 and does not revert
    const again = await v.send(A.castellan, "withdraw");
    expect(again.events[0].args).toMatchObject({ amount: 0n });
    expect((await v.c.balance(A.castellan)) - before).toBe(24_000n);
    await v.checkInvariant([A.castellan]);
  });

  it("a stranger withdraw gets nothing", async () => {
    const vb = await v.c.balance(v.address);
    await v.send(A.stranger, "withdraw");
    expect(await v.c.balance(v.address)).toBe(vb);
  });

  it("withdrawArena is onlyArena and pays the arena balance", async () => {
    await expectRevert(v.send(A.stranger, "withdrawArena"), "NotArena");
    await expectRevert(v.send(A.castellan, "withdrawArena"), "NotArena");
    expect(await v.read("arenaBalance")).toBe(1_500n);
    const before = await v.c.balance(A.arena);
    await v.send(A.arena, "withdrawArena");
    expect((await v.c.balance(A.arena)) - before).toBe(1_500n);
    expect(await v.read("arenaBalance")).toBe(0n);
    await v.checkInvariant([A.castellan]);
  });
});

describe("reentrancy", () => {
  it("a castellan contract re-entering withdraw/closeVault from receive gets paid exactly once", async () => {
    const v = await setup();
    const h = helpers.Reenterer;
    const evil = await v.c.deploy(A.stranger, h.abi, h.bytecode);
    const FEE = 10_000n;
    await v.createVault(FEE, 100n, evil, 5_000n); // vault 1 owned by evil
    await v.createVault(FEE, DAY, A.castellan, 9_000n); // an honest vault whose pot must stay put
    await v.recordAttempt(1n, "r-1", A.raider, FEE);
    await v.recordAttempt(2n, "r-2", A.raider, FEE);
    const call = (fn: string) =>
      v.c.raw(A.stranger, evil, encodeFunctionData({ abi: h.abi, functionName: fn, args: fn === "arm" ? [v.address, 1n, CloseReason.Expired] : [] }), 0n, h.abi);
    await call("arm");

    await call("doWithdraw");
    const recv = async () =>
      decodeFunctionResult({
        abi: h.abi,
        functionName: "received",
        data: (await v.c.raw(A.stranger, evil, encodeFunctionData({ abi: h.abi, functionName: "received" }), 0n, h.abi)).returnValue,
      }) as bigint;
    expect(await recv()).toBe(8_000n); // castellan cut, once
    expect(await v.read("castellanBalance", [evil])).toBe(0n);

    v.c.warp(100n);
    await call("doClose");
    expect(await recv()).toBe(8_000n + 5_000n + 1_500n); // + pot refund, once
    expect((await v.getVault(1n)).status).toBe(Status.Closed);
    expect((await v.getVault(2n)).pot).toBe(9_000n + 1_500n);
    await v.checkInvariant([evil, A.castellan]);
  });

  it("re-entering from an OwnerClosed refund (before the deadline) is also paid exactly once", async () => {
    const v = await setup();
    const h = helpers.Reenterer;
    const evil = await v.c.deploy(A.stranger, h.abi, h.bytecode);
    await v.createVault(1_000n, DAY, evil, 7_000n);
    await v.createVault(1_000n, DAY, A.castellan, 9_000n);
    const call = (fn: string, args: readonly unknown[] = []) =>
      v.c.raw(A.stranger, evil, encodeFunctionData({ abi: h.abi, functionName: fn, args }), 0n, h.abi);
    await call("arm", [v.address, 1n, CloseReason.OwnerClosed]);
    await call("doOwnerClose");
    expect(decodeFunctionResult({ abi: h.abi, functionName: "hits", data: (await call("hits")).returnValue })).toBeGreaterThan(0n);
    const received = decodeFunctionResult({ abi: h.abi, functionName: "received", data: (await call("received")).returnValue }) as bigint;
    expect(received).toBe(7_000n);
    expect(await v.getVault(1n)).toMatchObject({ status: Status.Closed, pot: 0n });
    expect((await v.getVault(2n)).pot).toBe(9_000n);
    await v.checkInvariant([evil, A.castellan]);
  });
});

describe("invariant: balance == sum(pots) + sum(castellanBalance) + arenaBalance", () => {
  it("holds after a scripted mixed sequence", async () => {
    const v = await setup();
    const cs = [A.castellan, A.castellan2];
    await v.createVault(12_345n, DAY, A.castellan, 100_000n);
    await v.createVault(1_000n, 2n * DAY, A.castellan2, 50_000n);
    await v.createVault(777n, DAY / 2n, A.castellan, 3n);
    await v.checkInvariant(cs);
    for (let i = 0; i < 4; i++) {
      await v.recordAttempt(1n, `a1-${i}`, A.raider, 12_345n);
      await v.recordAttempt(2n, `a2-${i}`, A.raider2, 1_000n);
      await v.recordAttempt(3n, `a3-${i}`, A.raider, 777n);
      await v.checkInvariant(cs);
    }
    await v.send(A.castellan, "withdraw");
    await v.checkInvariant(cs);
    const sig = await v.sign({ vaultId: 2n, raider: A.raider, transcriptHash: th("x"), siege: "b2" });
    await v.release(2n, A.raider, th("x"), "b2", sig, 1_000n);
    await v.checkInvariant(cs);
    v.c.warp(DAY / 2n);
    await v.close(3n, CloseReason.Expired, A.castellan);
    await v.checkInvariant(cs);
    await v.send(A.arena, "withdrawArena");
    await v.checkInvariant(cs);
    await v.recordAttempt(1n, "a1-late", A.raider, 12_345n);
    await v.checkInvariant(cs);
    await v.send(A.castellan2, "withdraw");
    const r = await v.checkInvariant(cs);
    expect(r.ab).toBe(617n);
    expect(r.cb).toBe(9876n);
  });

  it("holds across a sequence mixing all three close reasons, breaks, withdrawals and late attempts", async () => {
    const v = await setup();
    const cs = [A.castellan, A.castellan2];
    const fee = 3_333n;
    // vaults 1..6: two per castellan per close path, plus one that breaks and one that stays open
    const plan: { castellan: Address; pot: bigint; dur: bigint; tool: string }[] = [
      { castellan: A.castellan, pot: 40_000n, dur: DAY, tool: HOSTED_TOOL }, // 1: Expired (castellan)
      { castellan: A.castellan2, pot: 25_000n, dur: 3n * DAY, tool: "issue_refund" }, // 2: OrdersChanged (arena)
      { castellan: A.castellan, pot: 11n, dur: 3n * DAY, tool: "send_email" }, // 3: OwnerClosed (castellan)
      { castellan: A.castellan2, pot: 99_999n, dur: 3n * DAY, tool: HOSTED_TOOL }, // 4: OwnerClosed (arena)
      { castellan: A.castellan, pot: 5_000n, dur: 3n * DAY, tool: HOSTED_TOOL }, // 5: Broken
      { castellan: A.castellan2, pot: 1n, dur: 3n * DAY, tool: "x".repeat(64) }, // 6: stays open
    ];
    for (const p of plan) await v.createVault(fee, p.dur, p.castellan, p.pot, A.arena, p.tool);
    await v.checkInvariant(cs);
    for (let round = 0; round < 3; round++) {
      for (let id = 1n; id <= 6n; id++) await v.recordAttempt(id, `mix-${round}-${id}`, round % 2 ? A.raider : A.raider2, fee);
      await v.checkInvariant(cs);
    }
    // OrdersChanged mid-run, before anything expires
    const pot2 = (await v.getVault(2n)).pot;
    const c2 = await v.c.balance(A.castellan2);
    await v.close(2n, CloseReason.OrdersChanged, A.arena);
    expect((await v.c.balance(A.castellan2)) - c2).toBe(pot2);
    await v.checkInvariant(cs);
    // OwnerClosed by the castellan, then by the arena on another castle
    await v.close(3n, CloseReason.OwnerClosed, A.castellan);
    await v.checkInvariant(cs);
    await v.send(A.castellan2, "withdraw");
    await v.close(4n, CloseReason.OwnerClosed, A.arena);
    await v.checkInvariant(cs);
    // a break on vault 5
    const T = th("mix-break");
    await v.release(5n, A.raider, T, "mix-break", await v.sign({ vaultId: 5n, raider: A.raider, transcriptHash: T, siege: "mix-break" }), fee);
    await v.checkInvariant(cs);
    // Expired close on vault 1 is refused until the deadline, then succeeds
    await expectRevert(v.close(1n, CloseReason.Expired, A.castellan), "NotExpired");
    v.c.warp(DAY);
    await v.close(1n, CloseReason.Expired, A.castellan);
    await v.checkInvariant(cs);
    // closed and broken vaults refuse everything; vault 6 keeps going
    for (const id of [1n, 2n, 3n, 4n, 5n]) {
      await expectRevert(v.recordAttempt(id, `late-${id}`, A.raider, fee), "BadStatus");
      for (const reason of ALL_REASONS) await expectRevert(v.close(id, reason, A.arena), "BadStatus");
    }
    await v.send(A.arena, "withdrawArena");
    await v.send(A.castellan, "withdraw");
    await v.recordAttempt(6n, "mix-late", A.raider, fee);
    const r = await v.checkInvariant(cs);
    // only vault 6 holds a pot now; castellan is fully withdrawn; the arena holds just the late attempt's cut
    expect(r.pots).toBe((await v.getVault(6n)).pot);
    expect(r.cb).toBe(await v.read<bigint>("castellanBalance", [A.castellan2]));
    expect(r.ab).toBe((fee * 500n) / 10_000n);
    expect(await v.read("protectedTool", [6n])).toBe("x".repeat(64));
  });

  it("holds after 300 seeded random operations (every close reason succeeds at least once)", async () => {
    const v = await setup();
    const cs = [A.castellan, A.castellan2, A.stranger];
    let seed = 0x5eed;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let n = 0;
    const counts: Record<string, number> = {};
    for (let step = 0; step < 300; step++) {
      const next = Number(await v.read<bigint>("nextVaultId"));
      const op = next === 1 ? 0 : rnd(7);
      const id = BigInt(1 + rnd(Math.max(1, next - 1)));
      let name = "";
      try {
        if (op === 0) {
          name = "create";
          await v.createVault(BigInt(1 + rnd(50_000)), BigInt(1 + rnd(5_000)), cs[rnd(3)], BigInt(1 + rnd(1_000_000)));
        } else if (op <= 2) {
          name = "attempt";
          const fee = (await v.getVault(id)).fee;
          await v.recordAttempt(id, `rand-${n++}`, A.raider, rnd(10) === 0 ? fee + 1n : fee);
        } else if (op === 3) {
          name = "release";
          const fee = (await v.getVault(id)).fee;
          const siege = `rand-${n++}`;
          const raider = rnd(2) ? A.raider : A.raider2;
          const sig = await v.sign({ vaultId: id, raider, transcriptHash: th(siege), siege }, rnd(5) === 0 ? acct.impostor : acct.verifier);
          await v.release(id, raider, th(siege), siege, sig, fee);
        } else if (op === 4) {
          const reason = ALL_REASONS[rnd(3)];
          name = `close${reason}`;
          const who = rnd(3);
          await v.close(id, reason, who === 0 ? A.arena : who === 1 ? (await v.getVault(id)).castellan : A.stranger);
        } else if (op === 5) {
          name = "withdraw";
          await v.send(cs[rnd(3)], "withdraw");
        } else {
          name = "warp+arena";
          v.c.warp(BigInt(rnd(1_500)));
          if (rnd(3) === 0) await v.send(A.arena, "withdrawArena");
        }
        counts[name] = (counts[name] ?? 0) + 1;
      } catch (e) {
        if (!(e instanceof RevertError)) throw e;
        counts[`${name}:${e.errorName}`] = (counts[`${name}:${e.errorName}`] ?? 0) + 1;
      }
      await v.checkInvariant(cs);
    }
    // the walk must actually exercise the interesting paths
    expect(counts.attempt ?? 0).toBeGreaterThan(5);
    expect(counts.release ?? 0).toBeGreaterThan(0);
    expect(counts["release:BadSignature"] ?? 0).toBeGreaterThan(0);
    // and every close path, successful at least once
    for (const reason of ALL_REASONS) expect(counts[`close${reason}`] ?? 0, `close reason ${reason}`).toBeGreaterThan(0);
  }, 60_000);
});
