import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { TxRef } from "@/lib/types";
import { env, isStub } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { accountBalance } from "@/lib/chain/mirror";
import { isStubRef, txUrl } from "@/lib/chain/hashscan";
import { revokeZg } from "@/lib/zg/connect";
import { agentCredentials, agentRow, stubTxRef } from "./accounts";

/**
 * Unit money out (onboarding 2b): the unit's balance, and WITHDRAW back to the wallet that funded it.
 * Only operator-funded units are withdrawn; the arena's own demo units never send money anywhere.
 */

const HBAR = 100_000_000;
/** Left in the unit's account for the transfer fee itself. */
export const WITHDRAW_RESERVE_TINYBAR = HBAR / 10;
const BALANCE_TTL_MS = 15_000;

const g = globalThis as unknown as { __siegeUnitBalances?: Map<string, { at: number; v: bigint }> };
const cache = (g.__siegeUnitBalances ??= new Map());

export function clearUnitBalanceCache(): void {
  cache.clear();
}

/**
 * Stub only: breach payouts released to this unit (pot + fee of every op it broke). On testnet they
 * land in the unit's account on chain and the mirror balance includes them.
 */
export function stubPayoutsTinybar(agentId: string): number {
  const row = db()
    .select({ n: sql<number>`coalesce(sum(${schema.sieges.releaseAmountTinybar}), 0)` })
    .from(schema.sieges)
    .where(and(eq(schema.sieges.agentId, agentId), isNotNull(schema.sieges.releaseTx)))
    .get();
  return Number(row?.n ?? 0);
}

/**
 * The unit's balance in tinybar. Stub: budget - spent + breach payouts (the stub chain moves no HBAR).
 * Testnet: the mirror node's account balance, cached 15 s per unit. Null when the mirror is unreachable.
 */
export async function unitBalance(agentId: string): Promise<bigint | null> {
  const r = agentRow(agentId);
  if (!r) return null;
  if (isStub()) return BigInt(Math.max(0, r.budgetTinybar - r.spentTinybar + stubPayoutsTinybar(agentId)));
  const hit = cache.get(agentId);
  if (hit && Date.now() - hit.at < BALANCE_TTL_MS) return hit.v;
  try {
    const v = await accountBalance(r.accountId);
    cache.set(agentId, { at: Date.now(), v });
    return v;
  } catch {
    return hit?.v ?? null;
  }
}

/**
 * One HBAR transfer from the unit's account, signed with the unit's own key (the pattern of
 * topUpAgent, reversed). Stub returns a stub tx and moves nothing.
 */
export async function transferFromUnit(agentId: string, to: string, tinybar: bigint | number, memo = "siege withdraw"): Promise<TxRef> {
  const amount = BigInt(tinybar);
  if (amount <= BigInt(0)) throw new Error("invalid_amount");
  const r = agentRow(agentId);
  if (!r) throw new Error(`agent ${agentId} not found`);
  if (isStub()) return stubTxRef();
  const creds = agentCredentials(agentId);
  if (!creds.privateKey) throw new Error("unit_has_no_key");
  const { sdk, parsePrivateKey } = await import("@/lib/pay/hedera");
  const { Client, TransferTransaction, Hbar, AccountId } = await sdk();
  const key = await parsePrivateKey(creds.privateKey);
  const client = env().HEDERA_NETWORK === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  client.setOperator(AccountId.fromString(r.accountId), key);
  try {
    const resp = await new TransferTransaction()
      .addHbarTransfer(AccountId.fromString(r.accountId), Hbar.fromTinybars(String(-amount)))
      .addHbarTransfer(AccountId.fromString(to), Hbar.fromTinybars(String(amount)))
      .setTransactionMemo(memo.slice(0, 100))
      .execute(client);
    await resp.getReceipt(client);
    const txId = resp.transactionId.toString();
    cache.delete(agentId);
    return { txId, hashscanUrl: txUrl(txId), ...(isStubRef(txId) ? { stub: true } : {}) };
  } finally {
    client.close();
  }
}

export type WithdrawResult =
  | { ok: true; withdraw: TxRef; amount: string }
  | { ok: false; status: number; error: "not_operator_funded" | "unit_busy" | "funds_reserved" | "nothing_to_withdraw" | "no_destination" | "withdraw_failed"; message?: string };

/**
 * WITHDRAW: unit idle (or stopped), no active run, nothing reserved, no pending approval. Sends
 * balance - 0.1 ℏ to the unit's owner (the account that funded it), then budget = spent and the 0G key
 * is revoked best effort. The unit's status becomes `stopped`.
 */
export async function withdrawUnit(agentId: string): Promise<WithdrawResult> {
  const r = agentRow(agentId);
  if (!r) return { ok: false, status: 404, error: "unit_busy", message: "no such unit" };
  if (r.fundedBy !== "operator") return { ok: false, status: 409, error: "not_operator_funded", message: "Only a unit you funded can be withdrawn." };
  // A unit must hold its OWN account: never send the arena's shared demo raider wallet anywhere.
  if (!isStub() && (!r.privateKey || r.accountId === env().RAIDER_OPERATOR_ID)) {
    return { ok: false, status: 409, error: "not_operator_funded", message: "This unit has no account of its own to withdraw from." };
  }
  if (r.status === "running" || r.status === "paused") return { ok: false, status: 409, error: "unit_busy", message: "Stop the unit first." };
  const run = db().select({ id: schema.agentRuns.id }).from(schema.agentRuns).where(and(eq(schema.agentRuns.agentId, agentId), eq(schema.agentRuns.status, "active"))).get();
  if (run) return { ok: false, status: 409, error: "unit_busy", message: "A run is still active." };
  const reserved = db()
    .select({ id: schema.agentSpend.id })
    .from(schema.agentSpend)
    .where(and(eq(schema.agentSpend.agentId, agentId), eq(schema.agentSpend.state, "reserved")))
    .get();
  if (reserved) return { ok: false, status: 409, error: "funds_reserved", message: "A payment is still in flight." };
  if (!r.ownerId || r.ownerId === "owner") return { ok: false, status: 409, error: "no_destination", message: "This unit has no funding wallet." };

  const bal = await unitBalance(agentId);
  const amount = (bal ?? BigInt(0)) - BigInt(WITHDRAW_RESERVE_TINYBAR);
  if (amount <= BigInt(0)) return { ok: false, status: 409, error: "nothing_to_withdraw", message: "The balance does not cover the transfer fee." };

  // Claim the unit (idle -> stopped) so a run cannot start while the money is moving.
  const claimed = db()
    .update(schema.raiderAgents)
    .set({ status: "stopped" })
    .where(and(eq(schema.raiderAgents.id, agentId), eq(schema.raiderAgents.status, r.status)))
    .run();
  if (claimed.changes !== 1) return { ok: false, status: 409, error: "unit_busy", message: "The unit changed state; try again." };
  let ref: TxRef;
  try {
    ref = await transferFromUnit(agentId, r.ownerId, amount, `siege withdraw ${r.name}`);
  } catch (e) {
    db().update(schema.raiderAgents).set({ status: r.status }).where(eq(schema.raiderAgents.id, agentId)).run();
    return { ok: false, status: 502, error: "withdraw_failed", message: e instanceof Error ? e.message.slice(0, 200) : "transfer failed" };
  }
  // Nothing left to spend. Stub: the payouts were counted into the balance, so take them out too.
  const budgetAfter = r.spentTinybar - (isStub() ? stubPayoutsTinybar(agentId) : 0);
  db().update(schema.raiderAgents).set({ budgetTinybar: budgetAfter }).where(eq(schema.raiderAgents.id, agentId)).run();
  void revokeZg({ mgmtKey: r.zgMgmtKey, keyId: r.zgKeyId }).catch(() => false);
  return { ok: true, withdraw: ref, amount: amount.toString() };
}
