import { keccak256, toBytes, getAddress } from "viem";
import { env } from "@/lib/config/env";
import { normalizeTxId } from "./hashscan";
export { normalizeTxId };

/**
 * Hedera mirror node reads. Server only. Stub mode never touches the network.
 */

const evmCache = new Map<string, `0x${string}`>();

function mirrorBase(): string {
  return `${env().HEDERA_MIRROR_URL.replace(/\/$/, "")}/api/v1`;
}

export class MirrorHttpError extends Error {
  constructor(
    readonly status: number,
    path: string,
  ) {
    super(`mirror ${path}: HTTP ${status}`);
    this.name = "MirrorHttpError";
  }
}

async function mirrorGet<T>(path: string): Promise<T> {
  const res = await fetch(`${mirrorBase()}${path}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new MirrorHttpError(res.status, path);
  return (await res.json()) as T;
}

/** "0.0.1234" -> 0x00000000000000000000000000000000000004d2 (the account's long-zero EVM address). */
export function toLongZero(accountId: string): `0x${string}` {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(accountId.trim());
  if (!m) throw new Error(`toLongZero: not an account id: ${accountId}`);
  const shard = BigInt(m[1]).toString(16).padStart(8, "0");
  const realm = BigInt(m[2]).toString(16).padStart(16, "0");
  const num = BigInt(m[3]).toString(16).padStart(16, "0");
  return `0x${shard}${realm}${num}`;
}

/** Deterministic fake EVM address for stub accounts: first 20 bytes of keccak256(accountId). */
export function stubEvmAddress(accountId: string): `0x${string}` {
  return getAddress(keccak256(toBytes(accountId)).slice(0, 42));
}

/**
 * The EVM address that receives value for a Hedera account: the mirror's evm_address (ECDSA alias)
 * when present, else the long-zero address. Accepts a 0x address as-is.
 *
 * `strict: true` THROWS when the mirror cannot be read instead of falling back to long-zero. Use it
 * wherever the address is signed over (the EIP-712 Release): a fallback on one call and the alias on
 * the next would make the signature cover a different raider than the one sent.
 */
export async function accountEvmAddress(accountId: string, opts: { strict?: boolean } = {}): Promise<`0x${string}`> {
  if (/^0x[0-9a-fA-F]{40}$/.test(accountId)) return getAddress(accountId);
  if (env().CHAIN_MODE === "stub") return stubEvmAddress(accountId);
  const hit = evmCache.get(accountId);
  if (hit) return hit;
  let addr: `0x${string}`;
  try {
    const a = await mirrorGet<{ evm_address?: string | null }>(`/accounts/${encodeURIComponent(accountId)}`);
    addr = a.evm_address && /^0x[0-9a-fA-F]{40}$/.test(a.evm_address) ? getAddress(a.evm_address) : toLongZero(accountId);
  } catch (err) {
    if (opts.strict) throw new Error(`mirror_unavailable: ${err instanceof Error ? err.message : String(err)}`);
    // Mirror lag or outage: long-zero always routes to the account. Do not cache the fallback.
    return toLongZero(accountId);
  }
  evmCache.set(accountId, addr);
  return addr;
}

/** Tests: forget cached account -> EVM address lookups. */
export function resetMirrorCache() {
  evmCache.clear();
}

export type TxResult = { state: "success" } | { state: "failed"; result: string } | { state: "unknown" };

/**
 * Consensus result of a Hedera transaction id ("0.0.5@sec.nanos") from the mirror node.
 * "unknown" = the mirror has not seen it (yet). Throws only on mirror errors other than 404.
 */
export async function transactionResult(txId: string): Promise<TxResult> {
  let r: { transactions?: { result?: string; nonce?: number; scheduled?: boolean }[] };
  try {
    r = await mirrorGet(`/transactions/${encodeURIComponent(normalizeTxId(txId))}`);
  } catch (err) {
    if (err instanceof MirrorHttpError && err.status === 404) return { state: "unknown" };
    throw err;
  }
  const txs = r.transactions ?? [];
  if (!txs.length) return { state: "unknown" };
  // A duplicate submission shows up as a second entry (DUPLICATE_TRANSACTION); the primary decides.
  if (txs.some((t) => t.result === "SUCCESS" && (t.nonce ?? 0) === 0 && !t.scheduled)) return { state: "success" };
  const primary = txs.find((t) => (t.nonce ?? 0) === 0 && t.result !== "DUPLICATE_TRANSACTION") ?? txs[0];
  return { state: "failed", result: primary.result ?? "UNKNOWN" };
}

/**
 * What became of an HCS submit (by its transaction id): "landed" with the topic sequence number,
 * "failed" (reached consensus with another status), or "unknown" (the mirror has not seen it).
 */
export async function topicSubmitResult(
  txId: string,
): Promise<{ state: "landed"; seq: number } | { state: "failed"; reason: string } | { state: "unknown" }> {
  let r: { transactions?: { result?: string; nonce?: number; scheduled?: boolean; consensus_timestamp?: string }[] };
  try {
    r = await mirrorGet(`/transactions/${encodeURIComponent(normalizeTxId(txId))}`);
  } catch (err) {
    if (err instanceof MirrorHttpError && err.status === 404) return { state: "unknown" };
    throw err;
  }
  const txs = r.transactions ?? [];
  if (!txs.length) return { state: "unknown" };
  const ok = txs.find((t) => t.result === "SUCCESS" && (t.nonce ?? 0) === 0 && !t.scheduled);
  if (!ok) {
    const primary = txs.find((t) => (t.nonce ?? 0) === 0 && t.result !== "DUPLICATE_TRANSACTION") ?? txs[0];
    return { state: "failed", reason: primary.result ?? "UNKNOWN" };
  }
  if (!ok.consensus_timestamp) return { state: "unknown" };
  let m: { sequence_number?: number };
  try {
    m = await mirrorGet(`/topics/messages/${encodeURIComponent(ok.consensus_timestamp)}`);
  } catch (err) {
    if (err instanceof MirrorHttpError && err.status === 404) return { state: "unknown" };
    throw err;
  }
  return typeof m.sequence_number === "number" ? { state: "landed", seq: m.sequence_number } : { state: "unknown" };
}

export type MirrorLog = { transactionHash: `0x${string}`; data: `0x${string}`; topics: `0x${string}`[]; timestamp: string };

/**
 * Contract logs from the mirror node, filtered by topics (topic filters need a timestamp range,
 * at most 7 days). Used to reconcile a SiegeVault write whose receipt we never saw.
 */
export async function contractLogs(
  address: string,
  q: { topic0: string; topic1?: string; topic2?: string; fromMs: number; toMs?: number; limit?: number },
): Promise<MirrorLog[]> {
  const toSec = (ms: number) => (ms / 1000).toFixed(9);
  const p = new URLSearchParams();
  p.set("topic0", q.topic0);
  if (q.topic1) p.set("topic1", q.topic1);
  if (q.topic2) p.set("topic2", q.topic2);
  p.append("timestamp", `gte:${toSec(q.fromMs)}`);
  p.append("timestamp", `lte:${toSec(Math.min(q.toMs ?? Date.now() + 60_000, q.fromMs + 7 * 86_400_000 - 1000))}`);
  p.set("order", "asc");
  p.set("limit", String(q.limit ?? 5));
  const r = await mirrorGet<{
    logs?: { transaction_hash: string; data: string; topics: string[]; timestamp: string }[];
  }>(`/contracts/${encodeURIComponent(address)}/results/logs?${p}`);
  return (r.logs ?? []).map((l) => ({
    transactionHash: l.transaction_hash.slice(0, 66) as `0x${string}`,
    data: (l.data || "0x") as `0x${string}`,
    topics: l.topics as `0x${string}`[],
    timestamp: l.timestamp,
  }));
}

/** The account id whose EVM alias is `evm` ("0x…"), or null when the mirror knows none (yet). */
export async function accountIdForEvm(evm: string): Promise<string | null> {
  try {
    const a = await mirrorGet<{ account?: string | null }>(`/accounts/${encodeURIComponent(evm.toLowerCase())}`);
    return a.account ?? null;
  } catch (err) {
    if (err instanceof MirrorHttpError && err.status === 404) return null;
    throw err;
  }
}

/** Account balance in tinybars (testnet only). */
export async function accountBalance(accountId: string): Promise<bigint> {
  const a = await mirrorGet<{ balance?: { balance?: number } }>(`/accounts/${encodeURIComponent(accountId)}`);
  return BigInt(a.balance?.balance ?? 0);
}

export type TopicMessage = {
  seq: number;
  /** Decoded UTF-8 message. */
  message: string;
  /** Parsed JSON when the message is JSON (our audit messages are). */
  json?: Record<string, unknown>;
  consensusTimestamp: string;
};

/** Latest messages of an HCS topic, newest first. */
export async function topicMessages(topicId: string, limit = 25): Promise<TopicMessage[]> {
  const r = await mirrorGet<{ messages?: { message: string; sequence_number: number; consensus_timestamp: string }[] }>(
    `/topics/${encodeURIComponent(topicId)}/messages?order=desc&limit=${Math.max(1, Math.min(100, limit))}`,
  );
  return (r.messages ?? []).map((m) => {
    const message = Buffer.from(m.message, "base64").toString("utf8");
    let json: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(message);
      if (parsed && typeof parsed === "object") json = parsed as Record<string, unknown>;
    } catch {
      /* not JSON */
    }
    return { seq: m.sequence_number, message, json, consensusTimestamp: m.consensus_timestamp };
  });
}

export type AccountTransfer = {
  /** Mirror transaction id ("0.0.9185802-1793983423-475432254"). */
  txId: string;
  /** Paying account: the transaction id before its first "-". */
  payer: string;
  /** Decoded memo, trimmed. */
  memo: string;
  /** Sum of the positive HBAR transfers to the account, in tinybar (decimal string). */
  amountToAccount: string;
  consensusTimestamp: string;
};

type MirrorTransfersPage = {
  transactions?: {
    transaction_id: string;
    memo_base64?: string | null;
    consensus_timestamp: string;
    result?: string;
    transfers?: { account: string; amount: number }[];
  }[];
  links?: { next?: string | null };
};

/** Max mirror pages followed per call (100 transactions each): bounds a busy operator account. */
const MAX_TRANSFER_PAGES = 30;

/**
 * Successful CRYPTOTRANSFERs touching `accountId` since `sinceMs`, oldest first, with the HBAR that
 * reached the account (outgoing payments and transfers where the account is the payer are dropped).
 * Follows `links.next`. Used by the deposit matcher (lib/pay/deposits.ts).
 */
export async function accountTransfers(accountId: string, opts: { sinceMs: number; limit?: number }): Promise<AccountTransfer[]> {
  const p = new URLSearchParams();
  p.set("account.id", accountId);
  p.set("transactiontype", "CRYPTOTRANSFER");
  p.set("result", "success");
  p.set("timestamp", `gte:${(Math.max(0, opts.sinceMs) / 1000).toFixed(9)}`);
  p.set("order", "asc");
  p.set("limit", String(opts.limit ?? 100));
  let path: string | undefined = `/transactions?${p}`;
  const out: AccountTransfer[] = [];
  for (let page = 0; path && page < MAX_TRANSFER_PAGES; page++) {
    const r: MirrorTransfersPage = await mirrorGet<MirrorTransfersPage>(path);
    for (const t of r.transactions ?? []) {
      if (t.result && t.result !== "SUCCESS") continue;
      const payer = t.transaction_id.split("-")[0] ?? "";
      if (payer === accountId) continue;
      let amount = 0n;
      for (const tr of t.transfers ?? []) if (tr.account === accountId && tr.amount > 0) amount += BigInt(Math.trunc(tr.amount));
      if (amount <= 0n) continue;
      out.push({
        txId: t.transaction_id,
        payer,
        memo: Buffer.from(t.memo_base64 ?? "", "base64").toString("utf8").trim(),
        amountToAccount: amount.toString(),
        consensusTimestamp: t.consensus_timestamp,
      });
    }
    const next: string | null | undefined = r.links?.next;
    path = next ? next.replace(/^\/api\/v1/, "") : undefined;
  }
  return out;
}
