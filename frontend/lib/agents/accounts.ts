import { desc, eq, like, sql } from "drizzle-orm";
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

async function createHederaAccount(name: string, budgetTinybar: number) {
  const { sdk, operatorClient } = await import("@/lib/pay/hedera");
  const { AccountCreateTransaction, PrivateKey, Hbar } = await sdk();
  const client = await operatorClient();
  const key = PrivateKey.generateECDSA();
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
    evmAddress: `0x${key.publicKey.toEvmAddress()}`.toLowerCase(),
    privateKey: key.toStringRaw(),
    txId: resp.transactionId.toString(),
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
    ({ accountId, evmAddress, privateKey } = await createHederaAccount(name, budgetTinybar));
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
export async function topUpAgent(id: string, amount: Amount): Promise<TxRef> {
  const r = agentRow(id);
  if (!r) throw new Error(`agent ${id} not found`);
  const tinybar = toTinybar(amount, "0");

  let ref: TxRef;
  if (isStub() || tinybar === 0) {
    ref = stubTxRef();
  } else {
    const { sdk, operatorClient } = await import("@/lib/pay/hedera");
    const { TransferTransaction, Hbar, AccountId } = await sdk();
    const client = await operatorClient();
    const operator = client.operatorAccountId;
    if (!operator) throw new Error("Hedera operator not configured");
    const resp = await new TransferTransaction()
      .addHbarTransfer(operator, Hbar.fromTinybars(String(-tinybar)))
      .addHbarTransfer(AccountId.fromString(r.accountId), Hbar.fromTinybars(String(tinybar)))
      .setTransactionMemo(`siege top-up ${r.name}`.slice(0, 100))
      .execute(client);
    await resp.getReceipt(client);
    const txId = resp.transactionId.toString();
    ref = { txId, hashscanUrl: txUrl(txId) };
  }

  db()
    .update(schema.raiderAgents)
    .set({ budgetTinybar: sql`${schema.raiderAgents.budgetTinybar} + ${tinybar}` })
    .where(eq(schema.raiderAgents.id, id))
    .run();
  return ref;
}
