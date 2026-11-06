import { and, desc, eq, ne } from "drizzle-orm";
import { env } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import type { ChainPort, SiegeEvent, Verification } from "@/lib/types";
import { configuredChainId } from "./evm";
import { enqueueAudit } from "./outbox";
import { accountUrl, contractUrl, HASHSCAN_BASE, isStubRef, topicUrl } from "./hashscan";
import type { ReleaseTypedData } from "./releaseSig";
import { buildRelease, loadSettle, releaseRefusal } from "./settle";
import { stubChain } from "./stub";

export * from "./hashscan";
export * from "./units";
export { opIdToBytes32, releaseTypedData, verifierAddress, signRelease, type ReleaseTypedData } from "./releaseSig";
export { drainAudit, auditBacklog, syncAuditFromEvents, type DrainReport, type HcsPort } from "./outbox";

/**
 * lib/chain — the arena's on-chain side (SiegeVault on Hedera EVM + HCS audit topics).
 * `chain` picks the stub or the testnet implementation from env().CHAIN_MODE at call time;
 * the testnet code (Hedera SDK, RPC) is only loaded when CHAIN_MODE=testnet.
 */

async function impl(): Promise<ChainPort> {
  if (env().CHAIN_MODE === "stub") return stubChain();
  const { testnetChain } = await import("./testnet");
  return testnetChain();
}

export const chain: ChainPort = {
  get mode() {
    return env().CHAIN_MODE;
  },
  createVault: async (i) => (await impl()).createVault(i),
  recordAttempt: async (siegeId: string) => (await impl()).recordAttempt(siegeId),
  release: async (siegeId: string, verdict: Verification & { signature: `0x${string}` }) => (await impl()).release(siegeId, verdict),
  /**
   * Queues the message in the HCS audit outbox (lib/chain/outbox.ts) — synchronously, so calls keep
   * their order — and resolves `{ ok: true, topicId, seq }` where `seq` is the LOCAL per-topic sequence
   * ("queued"). The worker's drainer submits each topic in that order and records the HCS seq on the row.
   * siege.start / siege.message / siege.end are derived from the siege engine's events; callers audit
   * only what has no event of its own kind (siege.attempt, vault.release, vault.state, agent.approval).
   */
  audit: async (event: SiegeEvent) => {
    try {
      return enqueueAudit(db(), event, env().CHAIN_MODE);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
  createTopic: async (castleId: string) => (await impl()).createTopic(castleId),
  closeVault: async (vaultId, reason) => {
    try {
      return await (await impl()).closeVault(vaultId, reason);
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
};

/**
 * Worker: build the EIP-712 Release the verifier signs for a broken siege.
 * Refuses free sieges ("free_siege"), non-broken sieges ("bad_status"), missing transcript ("no_transcript").
 */
export async function prepareRelease(
  siegeId: string,
): Promise<{ ok: true; typedData: ReleaseTypedData; operator: `0x${string}`; vaultId: number } | { ok: false; reason: string }> {
  try {
    const d = db();
    const r = loadSettle(d, siegeId);
    if (!r.ok) return r;
    const refusal = releaseRefusal(d, r);
    if (refusal) return { ok: false, reason: refusal };
    return await buildRelease(r);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Which contract castles.vault_id values refer to under the current env: the lowercased
 * VAULT_ADDRESS on testnet, "stub" in stub mode (stored in castles.vault_address by seed).
 */
export function vaultTag(): string {
  const e = env();
  if (e.CHAIN_MODE === "stub") return "stub";
  return (e.VAULT_ADDRESS ?? "unset").toLowerCase();
}

/**
 * Testnet only: DB state that belongs to another chain (a stub-seeded DB, or vaults on a previous
 * deployment). Each line says what is wrong; empty = OK. The worker refuses to start on any.
 */
export function chainStateProblems(): string[] {
  const e = env();
  if (e.CHAIN_MODE === "stub") return [];
  const tag = vaultTag();
  const out: string[] = [];
  for (const c of db().select().from(schema.castles).all()) {
    if (c.vaultId != null && (c.vaultAddress ?? "").toLowerCase() !== tag)
      out.push(`${c.name}: vault #${c.vaultId} is on ${c.vaultAddress ?? "an unknown contract"}, not ${tag}`);
    if (c.topicId && isStubRef(c.topicId)) out.push(`${c.name}: HCS topic ${c.topicId} is a stub topic`);
    if (isStubRef(c.owner)) out.push(`${c.name}: castellan ${c.owner} is a stub account`);
  }
  for (const a of db().select().from(schema.raiderAgents).all()) {
    if (a.status !== "stopped" && isStubRef(a.accountId)) out.push(`agent ${a.name}: ${a.accountId} is a stub account`);
  }
  return out;
}

/**
 * Testnet only: whether the contract at VAULT_ADDRESS checks the Release this app signs. Reads
 * RELEASE_TYPEHASH and DOMAIN_SEPARATOR from the chain. Empty = OK, or not testnet. The worker
 * refuses to start on any, so a breach is never signed for a contract that would refuse to pay it.
 */
export async function contractProblems(): Promise<string[]> {
  const e = env();
  if (e.CHAIN_MODE === "stub") return [];
  if (!e.VAULT_ADDRESS) return ["VAULT_ADDRESS is not set (required when CHAIN_MODE=testnet)"];
  const [{ publicClient, rpcChainId }, { siegeVaultAbi }, { releaseCompatProblems }] = await Promise.all([import("./evm"), import("./abi/SiegeVault"), import("./releaseSig")]);
  const vault = e.VAULT_ADDRESS as `0x${string}`;
  const client = publicClient();
  try {
    const [typehash, separator, chainId] = await Promise.all([
      client.readContract({ address: vault, abi: siegeVaultAbi, functionName: "RELEASE_TYPEHASH" }),
      client.readContract({ address: vault, abi: siegeVaultAbi, functionName: "DOMAIN_SEPARATOR" }),
      // The chain id releases are signed for (lib/chain/settle.ts): it throws chain_id_mismatch when
      // the RPC disagrees with the configured network, so that fails here, not on every payout.
      rpcChainId(),
    ]);
    return releaseCompatProblems({ chainId, vault, typehash, domainSeparator: separator });
  } catch (err) {
    return [`could not read SiegeVault at ${vault}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`];
  }
}

export type ChainInfo = {
  mode: "stub" | "testnet";
  network: "hedera:testnet";
  chainId: number;
  vaultAddress?: string;
  vaultUrl?: string;
  treasury?: string;
  treasuryUrl?: string;
  explorer: string;
};

/** Public chain facts for /api/config. No secrets. */
export function chainInfo(): ChainInfo {
  const e = env();
  const stub = e.CHAIN_MODE === "stub";
  const treasury = e.X402_PAY_TO ?? e.HEDERA_OPERATOR_ID ?? (stub ? "0.0.stub-treasury" : undefined);
  return {
    mode: e.CHAIN_MODE,
    network: "hedera:testnet",
    chainId: configuredChainId(),
    vaultAddress: e.VAULT_ADDRESS,
    vaultUrl: e.VAULT_ADDRESS && !stub ? contractUrl(e.VAULT_ADDRESS) : undefined,
    treasury,
    treasuryUrl: treasury && !stub ? accountUrl(treasury) : undefined,
    explorer: HASHSCAN_BASE,
  };
}

export type AuditTrail = {
  topicId: string | null;
  topicUrl?: string;
  /**
   * Newest first. `seq` is the HCS topic sequence number once the message is on the topic, null while
   * it waits in the outbox (`state: "pending"`); `localSeq` is its place in the topic's order either way.
   */
  messages: {
    seq: number | null;
    localSeq: number | null;
    state: "pending" | "submitted";
    type: string;
    siegeId?: string;
    txId?: string;
    at: string;
  }[];
};

/**
 * The castle's audit trail from the audit outbox (audit_log): submitted messages with their HCS seq and
 * tx id, queued ones as pending. Shape matches GET /api/castles/[id] `audit`.
 */
export function auditTrail(castleId: string, limit = 25): AuditTrail {
  const d = db();
  const castle = d.select({ topicId: schema.castles.topicId }).from(schema.castles).where(eq(schema.castles.id, castleId)).get();
  const rows = d
    .select()
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.castleId, castleId), ne(schema.auditLog.state, "skipped")))
    .orderBy(desc(schema.auditLog.id))
    .limit(limit)
    .all();
  const topicId = castle?.topicId ?? rows[0]?.topicId ?? null;
  return {
    topicId,
    topicUrl: topicId ? topicUrl(topicId) : undefined,
    messages: rows.map((r) => {
      const submitted = r.state === "submitted";
      return {
        seq: submitted ? r.seq : null,
        localSeq: r.localSeq,
        state: submitted ? "submitted" : "pending",
        type: r.type,
        siegeId: r.siegeId ?? undefined,
        txId: submitted ? (r.txId ?? undefined) : undefined,
        at: r.at,
      };
    }),
  };
}
