import { desc, eq, inArray, like, ne, sql } from "drizzle-orm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Amount, RaiderAgent, RaiderAgentStatus, TxRef } from "@/lib/types";
import { env, isStub, required } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { newId, nowIso } from "@/lib/util/ids";
import { txUrl } from "@/lib/chain/hashscan";

/**
 * Raider agents and their Hedera accounts.
 *
 *  - per-agent mode (default) + testnet: each agent gets its own account (fresh ECDSA key + EVM alias),
 *    funded with its budget from the arena operator. The agent pays x402 fees from that account.
 *  - shared mode: every agent pays from RAIDER_OPERATOR_ID / RAIDER_OPERATOR_KEY.
 *  - stub: fake "0.0.stub-agent-<n>" accounts with a real (throwaway) EVM key so releases can be signed for.
 *
 * Private keys are test money only, live in the DB, and never leave the server (toAgent drops them).
 */

const HBAR = 100_000_000;

export const AGENT_DEFAULTS = {
  budget: String(10 * HBAR),
  perCastleCap: String(2 * HBAR),
  dailyCap: String(8 * HBAR),
  stopAfterLosses: 10,
  strategy: "authority",
  owner: "owner",
} as const;

const NAMES = ["Vex", "Morrow", "Kestrel", "Ashlock", "Quill", "Sable", "Brannoc", "Wren", "Corvid", "Thorne"];

type AgentRow = typeof schema.raiderAgents.$inferSelect;

export function toAgent(r: AgentRow): RaiderAgent {
  return {
    id: r.id,
    name: r.name,
    owner: r.ownerId,
    strategy: r.strategy,
    accountId: r.accountId,
    ...(r.evmAddress ? { evmAddress: r.evmAddress as `0x${string}` } : {}),
    budget: String(r.budgetTinybar),
    spent: String(r.spentTinybar),
    perCastleCap: String(r.perCastleCapTinybar),
    dailyCap: String(r.dailyCapTinybar),
    stopAfterLosses: r.stopAfterLosses,
    consecutiveLosses: r.consecutiveLosses,
    status: r.status,
    createdAt: r.createdAt,
    // Onboarding: cheap public fields only. Never the private key, the operator key hash, 0G keys or strategyText.
    fundedBy: r.fundedBy ?? "arena",
    ...(r.operatorKeyHash ? { hasOperatorKey: true } : {}),
    ...(r.zgApiKey || r.zgMgmtKey ? { zg: { connected: true, kind: r.zgMgmtKey ? ("mk" as const) : ("sk" as const) } } : {}),
  };
}

function toTinybar(a: Amount | undefined, fallback: string): number {
  const v = a === undefined || a === "" ? fallback : a;
  if (!/^\d+$/.test(String(v))) throw new Error(`Invalid amount ${v}: expected an integer string of tinybars`);
  return Number(v);
}

let stubTx = 0;
export function stubTxRef(): TxRef {
  const txId = `stub:0.0.0@${Date.now()}.${++stubTx}`;
  return { txId, hashscanUrl: txUrl(txId), stub: true };
}

/**
 * A per-agent account (fresh ECDSA key with its EVM alias), funded with the budget by the arena.
 * `keyHex` (onboarding units): a key stored BEFORE this call, so a retry after an unknown outcome
 * (receipt timeout, crash) reuses the same alias: if the mirror already knows an account for it, that
 * account is returned and nothing is sent again; a second create would fail on the taken alias anyway.
 */
async function createHederaAccount(name: string, budgetTinybar: number, keyHex?: string) {
  const { sdk, operatorClient } = await import("@/lib/pay/hedera");
  const { AccountCreateTransaction, PrivateKey, Hbar } = await sdk();
  const key = keyHex ? PrivateKey.fromStringECDSA(keyHex.replace(/^0x/, "")) : PrivateKey.generateECDSA();
  const evmAddress = `0x${key.publicKey.toEvmAddress()}`.toLowerCase();
  if (keyHex) {
    const { accountIdForEvm } = await import("@/lib/chain/mirror");
    const prior = await accountIdForEvm(evmAddress);
    if (prior) return { accountId: prior, evmAddress, privateKey: key.toStringRaw(), txId: null as string | null };
  }
  const client = await operatorClient();
  const tx = await new AccountCreateTransaction()
    .setECDSAKeyWithAlias(key)
    .setInitialBalance(Hbar.fromTinybars(String(budgetTinybar)))
    .setMaxAutomaticTokenAssociations(10)
    .setAccountMemo(`siege raider ${name}`.slice(0, 100))
    .freezeWith(client)
    .sign(key);
  const resp = await tx.execute(client);
  const receipt = await resp.getReceipt(client);
  if (!receipt.accountId) throw new Error("AccountCreateTransaction returned no account id");
  return {
    accountId: receipt.accountId.toString(),
    evmAddress,
    privateKey: key.toStringRaw(),
    txId: resp.transactionId.toString() as string | null,
  };
}

async function sharedAccount() {
  const accountId = required("RAIDER_OPERATOR_ID");
  const { mirrorEvmAddress, parsePrivateKey } = await import("@/lib/pay/hedera");
  let evm = await mirrorEvmAddress(accountId);
  if (!evm) {
    const key = await parsePrivateKey(required("RAIDER_OPERATOR_KEY"));
    evm = `0x${key.publicKey.toEvmAddress()}`.toLowerCase() as `0x${string}`;
  }
  return { accountId, evmAddress: evm };
}

export async function createAgent(
  i: {
    name?: string;
    strategy?: string;
    budget?: Amount;
    perCastleCap?: Amount;
    dailyCap?: Amount;
    stopAfterLosses?: number;
    owner?: string;
    /** Onboarding 2b (operator-funded units): sha256 of the rk_ key, free-text strategy, funding, 0G keys. */
    operatorKeyHash?: string | null;
    strategyText?: string | null;
    fundedBy?: "arena" | "operator";
    depositTx?: string | null;
    zgApiKey?: string | null;
    zgMgmtKey?: string | null;
    zgKeyId?: string | null;
    /** Per-agent testnet mode: reuse this stored ECDSA key (hex) instead of generating one (idempotent retries). */
    accountKey?: string | null;
  } = {},
): Promise<RaiderAgent> {
  const count = db().select({ n: sql<number>`count(*)` }).from(schema.raiderAgents).get()?.n ?? 0;
  const name = i.name?.trim() || `${NAMES[count % NAMES.length]}${count >= NAMES.length ? ` ${Math.floor(count / NAMES.length) + 1}` : ""}`;
  const budgetTinybar = toTinybar(i.budget, AGENT_DEFAULTS.budget);
  const perCastleCapTinybar = toTinybar(i.perCastleCap, AGENT_DEFAULTS.perCastleCap);
  const dailyCapTinybar = toTinybar(i.dailyCap, AGENT_DEFAULTS.dailyCap);

  let accountId: string;
  let evmAddress: string | null = null;
  let privateKey: string | null = null;

  if (isStub()) {
    const stubs =
      db()
        .select({ n: sql<number>`count(*)` })
        .from(schema.raiderAgents)
        .where(like(schema.raiderAgents.accountId, "0.0.stub-agent-%"))
        .get()?.n ?? 0;
    accountId = `0.0.stub-agent-${stubs + 1}`;
    privateKey = generatePrivateKey();
    evmAddress = privateKeyToAccount(privateKey as `0x${string}`).address.toLowerCase();
  } else if (env().RAIDER_ACCOUNT_MODE === "shared") {
    ({ accountId, evmAddress } = await sharedAccount());
  } else {
    ({ accountId, evmAddress, privateKey } = await createHederaAccount(name, budgetTinybar, i.accountKey ?? undefined));
  }

  const row = db()
    .insert(schema.raiderAgents)
    .values({
      id: newId("agent"),
      name,
      ownerId: i.owner ?? AGENT_DEFAULTS.owner,
      strategy: i.strategy ?? AGENT_DEFAULTS.strategy,
      accountId,
      evmAddress,
      privateKey,
      budgetTinybar,
      perCastleCapTinybar,
      dailyCapTinybar,
      stopAfterLosses: i.stopAfterLosses ?? AGENT_DEFAULTS.stopAfterLosses,
      status: "idle",
      createdAt: nowIso(),
      ...(i.operatorKeyHash ? { operatorKeyHash: i.operatorKeyHash } : {}),
      ...(i.strategyText ? { strategyText: i.strategyText } : {}),
      ...(i.fundedBy ? { fundedBy: i.fundedBy } : {}),
      ...(i.depositTx ? { depositTx: i.depositTx } : {}),
      ...(i.zgApiKey ? { zgApiKey: i.zgApiKey } : {}),
      ...(i.zgMgmtKey ? { zgMgmtKey: i.zgMgmtKey } : {}),
      ...(i.zgKeyId ? { zgKeyId: i.zgKeyId } : {}),
    })
    .returning()
    .get();
  return toAgent(row);
}

export function agentRow(id: string): AgentRow | null {
  return db().select().from(schema.raiderAgents).where(eq(schema.raiderAgents.id, id)).get() ?? null;
}

export function getAgent(id: string): RaiderAgent | null {
  const r = agentRow(id);
  return r ? toAgent(r) : null;
}

export function listAgents(): RaiderAgent[] {
  return db().select().from(schema.raiderAgents).orderBy(desc(schema.raiderAgents.createdAt)).all().map(toAgent);
}

/** Units that are not stopped: what AGENT_MAX_COUNT counts. */
export function activeAgentCount(): number {
  return db().select({ n: sql<number>`count(*)` }).from(schema.raiderAgents).where(ne(schema.raiderAgents.status, "stopped")).get()?.n ?? 0;
}

/** Units whose operator key hash is one of `hashes` (GET /api/agents?mine=1). */
export function agentsByOperatorHashes(hashes: string[]): RaiderAgent[] {
  if (!hashes.length) return [];
  return db()
    .select()
    .from(schema.raiderAgents)
    .where(inArray(schema.raiderAgents.operatorKeyHash, hashes))
    .orderBy(desc(schema.raiderAgents.createdAt))
    .all()
    .map(toAgent);
}

/** Server-only: what the agent pays x402 fees with. */
export function agentCredentials(id: string): { accountId: string; privateKey?: string } {
  const r = agentRow(id);
  if (!r) throw new Error(`agent ${id} not found`);
  if (r.privateKey) return { accountId: r.accountId, privateKey: r.privateKey };
  // shared mode: the agent pays from the raider operator account
  if (!isStub() && r.accountId === env().RAIDER_OPERATOR_ID) {
    return { accountId: r.accountId, privateKey: required("RAIDER_OPERATOR_KEY") };
  }
  return { accountId: r.accountId };
}

export function setAgentStatus(id: string, status: RaiderAgentStatus): RaiderAgent | null {
  const r = db().update(schema.raiderAgents).set({ status }).where(eq(schema.raiderAgents.id, id)).returning().get();
  return r ? toAgent(r) : null;
}

/**
 * Owner → agent top-up (approval). Testnet: a real HBAR transfer from the arena operator to the
 * agent's account. Always raises the agent's budget by `amount`.
 */
/** A transaction id's valid start in ms ("0.0.5@1793983423.475432254" or the mirror's "0.0.5-1793983423-475432254"). */
function validStartMs(txId: string): number {
  const m = /[@-](\d+)[.-](\d+)$/.exec(txId);
  return m ? Number(m[1]) * 1000 : 0;
}
/** Hedera rejects a transaction 120 s after its valid start; past this, an unseen tx id never lands. */
const TX_DEAD_AFTER_MS = 180_000;

export class TopUpInDoubt extends Error {
  constructor(readonly txId: string) {
    super(`topup_in_doubt: ${txId} not on the mirror yet; retrying later`);
  }
}

export async function topUpAgent(
  id: string,
  amount: Amount,
  /**
   * Idempotent top-ups (deposit handler): `priorTxId` = a tx id stored by an earlier attempt. If the mirror
   * shows it succeeded nothing is sent again; if it may still land, TopUpInDoubt. `onPrepared(txId)` runs
   * BEFORE the transfer is sent so the caller can store the pre-generated id.
   */
  opts: { priorTxId?: string | null; onPrepared?: (txId: string) => void } = {},
): Promise<TxRef> {
  const r = agentRow(id);
  if (!r) throw new Error(`agent ${id} not found`);
  const tinybar = toTinybar(amount, "0");

  let ref: TxRef | null = null;
  if (isStub() || tinybar === 0) {
    ref = stubTxRef();
  } else {
    if (opts.priorTxId) {
      const { transactionResult } = await import("@/lib/chain/mirror");
      const prior = await transactionResult(opts.priorTxId);
      if (prior.state === "success") ref = { txId: opts.priorTxId, hashscanUrl: txUrl(opts.priorTxId) };
      else if (prior.state === "unknown" && Date.now() - validStartMs(opts.priorTxId) < TX_DEAD_AFTER_MS) throw new TopUpInDoubt(opts.priorTxId);
    }
    if (!ref) {
      const { sdk, operatorClient } = await import("@/lib/pay/hedera");
      const { TransferTransaction, TransactionId, Hbar, AccountId } = await sdk();
      const client = await operatorClient();
      const operator = client.operatorAccountId;
      if (!operator) throw new Error("Hedera operator not configured");
      const txIdObj = TransactionId.generate(operator);
      opts.onPrepared?.(txIdObj.toString());
      const resp = await new TransferTransaction()
        .setTransactionId(txIdObj)
        .addHbarTransfer(operator, Hbar.fromTinybars(String(-tinybar)))
        .addHbarTransfer(AccountId.fromString(r.accountId), Hbar.fromTinybars(String(tinybar)))
        .setTransactionMemo(`siege top-up ${r.name}`.slice(0, 100))
        .execute(client);
      await resp.getReceipt(client);
      const txId = resp.transactionId.toString();
      ref = { txId, hashscanUrl: txUrl(txId) };
    }
  }

  db()
    .update(schema.raiderAgents)
    .set({ budgetTinybar: sql`${schema.raiderAgents.budgetTinybar} + ${tinybar}` })
    .where(eq(schema.raiderAgents.id, id))
    .run();
  return ref;
}
