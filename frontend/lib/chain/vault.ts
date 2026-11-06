import {
  BaseError,
  ContractFunctionRevertedError,
  TransactionReceiptNotFoundError,
  decodeEventLog,
  encodeEventTopics,
  parseEventLogs,
  type Hash,
  type TransactionReceipt,
} from "viem";
import { required } from "@/lib/config/env";
import { siegeVaultAbi } from "./abi/SiegeVault";
import { arenaAccount, publicClient, walletClient } from "./evm";
import { contractLogs } from "./mirror";
import { tinybarToWei } from "./units";

/**
 * Typed wrappers around SiegeVault on the Hedera relay. All amounts in/out are TINYBARS
 * (bigint); the `value` sent to the relay is converted to weibars here.
 * Each write is simulated first (so a revert surfaces as its custom error name), then sent with
 * an explicit gas limit and awaited.
 */

/** Explicit gas limits (the relay estimate is unreliable for payable calls). */
export const GAS = {
  createVault: BigInt(800_000),
  recordAttempt: BigInt(300_000),
  release: BigInt(400_000),
  closeVault: BigInt(250_000),
} as const;

/** SiegeVault.CloseReason enum order: Expired, OrdersChanged, OwnerClosed. */
export const CLOSE_REASON_INDEX = { expired: 0, orders_changed: 1, owner_closed: 2 } as const;
export type CloseReasonName = keyof typeof CLOSE_REASON_INDEX;
const CLOSE_REASON_NAMES = ["expired", "orders_changed", "owner_closed"] as const;

export const VAULT_STATUS = ["None", "Open", "Breached", "Closed"] as const;
export type VaultStatusName = (typeof VAULT_STATUS)[number];

/** A SiegeVault call failed. `errorName` is the contract's custom error (e.g. "WrongFee") when known. */
export class VaultError extends Error {
  constructor(
    readonly errorName: string,
    message: string,
    readonly txHash?: Hash,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export function vaultAddress(): `0x${string}` {
  return required("VAULT_ADDRESS") as `0x${string}`;
}

function revertName(err: unknown): string | null {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? "reverted";
  }
  return null;
}

function toVaultError(err: unknown, fn: string): VaultError {
  if (err instanceof VaultError) return err;
  const name = revertName(err);
  if (name) return new VaultError(name, `SiegeVault.${fn} reverted: ${name}`);
  const msg = err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);
  return new VaultError("rpc_error", `SiegeVault.${fn} failed: ${msg}`);
}

type WriteFn = "createVault" | "recordAttempt" | "release" | "closeVault";

/** Called with the tx hash right after the relay accepted it, BEFORE waiting for the receipt. */
export type OnSent = (hash: Hash) => void | Promise<void>;

async function write(fn: WriteFn, args: readonly unknown[], valueTinybar: bigint, onSent?: OnSent): Promise<TransactionReceipt> {
  const address = vaultAddress();
  // closeVault is not payable: send no value field at all for zero-value calls.
  const value = valueTinybar > BigInt(0) ? { value: tinybarToWei(valueTinybar) } : {};
  const account = arenaAccount();
  // 1) simulate: decode custom errors before spending gas. Non-revert RPC hiccups fall through to the send.
  try {
    await publicClient().simulateContract({
      address,
      abi: siegeVaultAbi,
      functionName: fn,
      args: args as never,
      ...value,
      account,
    } as never);
  } catch (err) {
    if (revertName(err)) throw toVaultError(err, fn);
  }
  // 2) send with explicit gas, 3) wait.
  let hash: Hash;
  try {
    hash = await walletClient().writeContract({
      address,
      abi: siegeVaultAbi,
      functionName: fn,
      args: args as never,
      ...value,
      gas: GAS[fn],
    } as never);
  } catch (err) {
    throw toVaultError(err, fn);
  }
  // The tx is out: record the hash first, so a timeout or crash below can be reconciled from it.
  if (onSent) {
    try {
      await onSent(hash);
    } catch (err) {
      console.warn(`[vault] could not record pending ${fn} tx ${hash}:`, err instanceof Error ? err.message : err);
    }
  }
  let receipt: TransactionReceipt;
  try {
    receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 90_000 });
  } catch (err) {
    const msg = err instanceof BaseError ? err.shortMessage : err instanceof Error ? err.message : String(err);
    throw new VaultError("receipt_timeout", `SiegeVault.${fn} sent (${hash}) but no receipt yet: ${msg}`, hash);
  }
  if (receipt.status !== "success") throw new VaultError("reverted", `SiegeVault.${fn} reverted on chain (${hash})`, hash);
  return receipt;
}

function logsOf<E extends "VaultCreated" | "AttemptRecorded" | "Breached" | "VaultClosed">(receipt: TransactionReceipt, eventName: E) {
  const logs = parseEventLogs({ abi: siegeVaultAbi, logs: receipt.logs, eventName });
  if (!logs.length) throw new VaultError("no_event", `SiegeVault: ${eventName} event missing in ${receipt.transactionHash}`, receipt.transactionHash);
  return logs[0];
}

/** Open a vault. `pot` is sent as msg.value; `protectedTool` (1..64 bytes) is stored on chain as metadata. */
export async function createVault(p: { fee: bigint; durationSec: bigint; owner: `0x${string}`; pot: bigint; protectedTool: string }) {
  const receipt = await write("createVault", [p.fee, p.durationSec, p.owner, p.protectedTool], p.pot);
  const ev = logsOf(receipt, "VaultCreated");
  return {
    txHash: receipt.transactionHash,
    vaultId: ev.args.vaultId,
    pot: ev.args.pot,
    fee: ev.args.fee,
    deadline: ev.args.deadline,
    protectedTool: ev.args.protectedTool,
  };
}

export type CloseResult = { txHash: Hash; refunded: bigint; reason: CloseReasonName };

/** Close an Open vault (pot back to the Owner). Simulated first, so a revert surfaces as its error name. */
export async function closeVault(p: { vaultId: bigint; reason: CloseReasonName }): Promise<CloseResult> {
  const receipt = await write("closeVault", [p.vaultId, CLOSE_REASON_INDEX[p.reason]], BigInt(0));
  const ev = logsOf(receipt, "VaultClosed");
  return { txHash: receipt.transactionHash, refunded: ev.args.refunded, reason: CLOSE_REASON_NAMES[Number(ev.args.reason)] ?? p.reason };
}

export type AttemptResult = {
  txHash: Hash;
  ownerCut: bigint;
  potCut: bigint;
  arenaCut: bigint;
  newPot: bigint;
  streak: number;
};
export type ReleaseResult = { txHash: Hash; amount: bigint };

const attemptOf = (txHash: Hash, a: { ownerCut: bigint; potCut: bigint; arenaCut: bigint; newPot: bigint; streak: number }): AttemptResult => ({
  txHash,
  ownerCut: a.ownerCut,
  potCut: a.potCut,
  arenaCut: a.arenaCut,
  newPot: a.newPot,
  streak: Number(a.streak),
});

/** Forward exactly `fee` tinybars for an op the guard held and split it. */
export async function recordAttempt(
  p: { vaultId: bigint; opId: `0x${string}`; operator: `0x${string}`; fee: bigint },
  onSent?: OnSent,
): Promise<AttemptResult> {
  const receipt = await write("recordAttempt", [p.vaultId, p.opId, p.operator], p.fee, onSent);
  return attemptOf(receipt.transactionHash, logsOf(receipt, "AttemptRecorded").args);
}

/** Pay pot + fee to the operator, authorised by the verifier signature. */
export async function release(p: {
  vaultId: bigint;
  operator: `0x${string}`;
  transcriptHash: `0x${string}`;
  opId: `0x${string}`;
  sig: `0x${string}`;
  fee: bigint;
}, onSent?: OnSent): Promise<ReleaseResult> {
  const receipt = await write("release", [p.vaultId, p.operator, p.transcriptHash, p.opId, p.sig], p.fee, onSent);
  return { txHash: receipt.transactionHash, amount: logsOf(receipt, "Breached").args.amount };
}

// ─── Reconciliation: a write that landed but whose result we never applied ──────

export type TxOutcome<T> = { status: "success"; result: T } | { status: "reverted" } | { status: "not_found" };

/** The mined result of an earlier recordAttempt/release tx, by hash. Throws only on RPC errors. */
export async function writeOutcome<E extends "AttemptRecorded" | "Breached">(
  hash: Hash,
  eventName: E,
): Promise<TxOutcome<E extends "AttemptRecorded" ? AttemptResult : ReleaseResult>> {
  let receipt: TransactionReceipt;
  try {
    receipt = await publicClient().getTransactionReceipt({ hash });
  } catch (err) {
    if (err instanceof TransactionReceiptNotFoundError || (err instanceof BaseError && err.walk((e) => e instanceof TransactionReceiptNotFoundError)))
      return { status: "not_found" };
    throw err;
  }
  if (receipt.status !== "success") return { status: "reverted" };
  const ev = logsOf(receipt, eventName);
  const result =
    eventName === "AttemptRecorded"
      ? attemptOf(receipt.transactionHash, (ev as ReturnType<typeof logsOf<"AttemptRecorded">>).args)
      : { txHash: receipt.transactionHash, amount: (ev as ReturnType<typeof logsOf<"Breached">>).args.amount };
  return { status: "success", result: result as E extends "AttemptRecorded" ? AttemptResult : ReleaseResult };
}

/** SiegeVault's global replay guard: true once recordAttempt or release consumed this op id. */
export async function opConsumed(opId: `0x${string}`): Promise<boolean> {
  return publicClient().readContract({ address: vaultAddress(), abi: siegeVaultAbi, functionName: "opConsumed", args: [opId] });
}

/**
 * Find the AttemptRecorded / Breached log SiegeVault emitted for an op id (indexed topic2), via the
 * mirror node (Hashio caps eth_getLogs ranges). Null if the mirror has not indexed it (yet).
 */
export async function findOpLog<E extends "AttemptRecorded" | "Breached">(
  eventName: E,
  vaultId: bigint,
  opId: `0x${string}`,
  sinceMs: number,
): Promise<(E extends "AttemptRecorded" ? AttemptResult : ReleaseResult) | null> {
  const [topic0, topic1, topic2] = encodeEventTopics({
    abi: siegeVaultAbi,
    eventName: eventName as "AttemptRecorded",
    args: { vaultId, opId },
  }) as `0x${string}`[];
  const logs = await contractLogs(vaultAddress(), { topic0, topic1, topic2, fromMs: sinceMs - 60_000 });
  for (const l of logs) {
    try {
      const d = decodeEventLog({ abi: siegeVaultAbi, data: l.data, topics: l.topics as [`0x${string}`, ...`0x${string}`[]] });
      if (d.eventName === "AttemptRecorded" && eventName === "AttemptRecorded") {
        return attemptOf(l.transactionHash, d.args) as E extends "AttemptRecorded" ? AttemptResult : ReleaseResult;
      }
      if (d.eventName === "Breached" && eventName === "Breached") {
        return { txHash: l.transactionHash, amount: d.args.amount } as E extends "AttemptRecorded" ? AttemptResult : ReleaseResult;
      }
    } catch {
      /* not ours */
    }
  }
  return null;
}

export type OnchainVault = {
  owner: `0x${string}`;
  pot: bigint;
  fee: bigint;
  deadline: bigint;
  status: VaultStatusName;
  streak: number;
};

export async function getVault(vaultId: bigint): Promise<OnchainVault> {
  const v = await publicClient().readContract({ address: vaultAddress(), abi: siegeVaultAbi, functionName: "getVault", args: [vaultId] });
  return {
    owner: v.owner,
    pot: v.pot,
    fee: v.fee,
    deadline: BigInt(v.deadline),
    status: VAULT_STATUS[v.status] ?? "None",
    streak: Number(v.streak),
  };
}
