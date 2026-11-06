import { and, eq } from "drizzle-orm";
import { recoverTypedDataAddress, type Hash } from "viem";
import { db as sharedDb, schema, type DB } from "@/lib/db";
import { env } from "@/lib/config/env";
import { voidInFlightSieges } from "@/lib/pay/refunds";
import type { Amount, ChainPort, FeeSplit, SiegeEvent, TxRef, VaultCloseReason, Verification } from "@/lib/types";
import { arenaAccount } from "./evm";
import { txUrl, isStubRef } from "./hashscan";
import * as hcs from "./hcs";
import { accountEvmAddress } from "./mirror";
import { opIdToBytes32, verifierAddress } from "./releaseSig";
import {
  attemptRefusal,
  buildRelease,
  closeVoidReason,
  isFreeSiege,
  loadSettle,
  releaseRefusal,
  validProtectedTool,
  verdictRefusal,
  type SettleRows,
} from "./settle";
import * as vault from "./vault";
import { enqueueAudit } from "./outbox";

/**
 * Real ChainPort: SiegeVault through the Hashio relay (viem) + HCS through the Hedera SDK.
 * Expected failures come back as { ok: false, reason }; nothing here throws to the caller.
 *
 * The one DB write: `sieges.pending_tx` is set right after a recordAttempt/release is broadcast and
 * before its receipt is awaited (write-ahead), so a receipt timeout, a relay hiccup or a worker crash
 * is reconciled from the chain on the next try instead of re-sending into Replay/BadStatus.
 * Reconciliation order: (1) the pending tx's receipt, (2) on Replay/BadStatus/receipt_timeout:
 * SiegeVault.opConsumed(id) and the AttemptRecorded/Broken log for that siege id (mirror node).
 */

const evmTx = (hash: string): TxRef => ({ txId: hash, hashscanUrl: txUrl(hash) });

/** Contract custom errors -> the worker's refusal vocabulary (see worker/settle.ts PERMANENT). */
const CONTRACT_REASON: Record<string, string> = {
  BadStatus: "vault_not_open",
  Expired: "expired",
  WrongFee: "wrong_fee",
  NotArena: "not_arena",
  BadArgs: "bad_args",
  NotAllowed: "not_allowed",
  BadSignature: "bad_signature",
  Replay: "already_consumed",
  NotExpired: "not_expired",
  PayFailed: "pay_failed",
};

function reasonOf(err: unknown): string {
  if (err instanceof vault.VaultError) {
    if (err.errorName === "rpc_error") return err.message;
    return CONTRACT_REASON[err.errorName] ?? err.errorName;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Errors after which the write may already be on chain. */
const MAYBE_LANDED = new Set(["Replay", "BadStatus", "receipt_timeout", "rpc_error", "reverted"]);

const recordPending = (d: DB, siegeId: string) => (hash: Hash) => {
  d.update(schema.sieges).set({ pendingTx: hash }).where(eq(schema.sieges.id, siegeId)).run();
};

/**
 * A write-ahead pending_tx that is PROVEN not to have landed (its receipt says reverted and the contract
 * has not consumed the siege id) is cleared, so the siege can be refused / voided and refunded normally
 * (e.g. a recordAttempt that lost the race against closeVault). Otherwise it would block voidSiege forever.
 */
async function clearRevertedPending(d: DB, r: SettleRows, hash: string): Promise<boolean> {
  if (await vault.opConsumed(opIdToBytes32(r.siege.id))) return false;
  const res = d
    .update(schema.sieges)
    .set({ pendingTx: null })
    .where(and(eq(schema.sieges.id, r.siege.id), eq(schema.sieges.pendingTx, hash)))
    .run();
  if (res.changes === 1) r.siege = { ...r.siege, pendingTx: null };
  return res.changes === 1;
}

/**
 * Before any refusal: did the pending write land? success -> its result; proven reverted -> pending_tx
 * cleared (returns null so the normal refusals apply); unknown -> null (refusals apply; voidSiege still
 * refuses while pending_tx is set).
 */
async function settlePending<E extends "AttemptRecorded" | "Breached">(
  d: DB,
  r: SettleRows,
  eventName: E,
): Promise<(E extends "AttemptRecorded" ? vault.AttemptResult : vault.ReleaseResult) | null> {
  const hash = r.siege.pendingTx;
  if (!hash) return null;
  const o = await vault.writeOutcome(hash as Hash, eventName);
  if (o.status === "success") return o.result;
  if (o.status === "reverted") await clearRevertedPending(d, r, hash);
  return null;
}

type AttemptOk = { ok: true; tx: TxRef; split: FeeSplit; newPot: Amount };
type ReleaseOk = { ok: true; tx: TxRef; amount: Amount };

const attemptOk = (a: vault.AttemptResult): AttemptOk => ({
  ok: true,
  tx: evmTx(a.txHash),
  split: { castellan: a.ownerCut.toString(), pot: a.potCut.toString(), arena: a.arenaCut.toString() },
  newPot: a.newPot.toString(),
});
const releaseOk = (a: vault.ReleaseResult): ReleaseOk => ({ ok: true, tx: evmTx(a.txHash), amount: a.amount.toString() });

/**
 * Did an earlier write for this siege land? Checks the tx hash we know about (pending_tx or the one in
 * the error), then — when the contract says the siege id is consumed — the event log for it.
 * Returns the result, "consumed_unindexed" (on chain but the mirror has no log yet: retry), or null.
 */
async function landed<E extends "AttemptRecorded" | "Breached">(
  r: SettleRows,
  eventName: E,
  hashes: (string | null | undefined)[],
  checkConsumed: boolean,
): Promise<(E extends "AttemptRecorded" ? vault.AttemptResult : vault.ReleaseResult) | "consumed_unindexed" | null> {
  for (const h of new Set(hashes.filter((x): x is string => Boolean(x)))) {
    const o = await vault.writeOutcome(h as Hash, eventName);
    if (o.status === "success") return o.result;
  }
  if (!checkConsumed || r.castle.vaultId == null) return null;
  const id = opIdToBytes32(r.siege.id);
  if (!(await vault.opConsumed(id))) return null;
  const since = Date.parse(r.siege.createdAt) || Date.now() - 6 * 86_400_000;
  const log = await vault.findOpLog(eventName, BigInt(r.castle.vaultId), id, since);
  return log ?? "consumed_unindexed";
}

async function castellanAddress(accountId: string): Promise<`0x${string}`> {
  if (!accountId || isStubRef(accountId) || !/^(0x[0-9a-fA-F]{40}|\d+\.\d+\.\d+)$/.test(accountId)) {
    // Fixture owners may be placeholders: the arena holds the castellan's cut until a real owner exists.
    console.warn(`[chain] castellan "${accountId}" is not a Hedera account; using the arena address`);
    return arenaAccount().address;
  }
  return accountEvmAddress(accountId);
}

export function createTestnetChain(getDb: () => DB = sharedDb): ChainPort {
  return {
    mode: "testnet",

    async createVault(i: { castleId: string; pot: Amount; fee: Amount; durationSec: number; castellan: string; protectedTool: string }) {
      if (!validProtectedTool(i.protectedTool)) return { ok: false, reason: "bad_args" };
      try {
        const res = await vault.createVault({
          fee: BigInt(i.fee),
          durationSec: BigInt(Math.floor(i.durationSec)),
          owner: await castellanAddress(i.castellan),
          pot: BigInt(i.pot),
          protectedTool: i.protectedTool,
        });
        return { ok: true, vaultId: Number(res.vaultId), tx: evmTx(res.txHash) };
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      }
    },

    async recordAttempt(siegeId: string) {
      const d = getDb();
      const r = loadSettle(d, siegeId);
      if (!r.ok) return r;
      // An earlier try may have landed (receipt timeout, crash before the DB write). Check it BEFORE
      // the DB-level refusals: a sibling's release recorded since must not hide our own landed write.
      if (r.siege.pendingTx && !r.siege.attemptTx && !isFreeSiege(r)) {
        try {
          const prior = await settlePending(d, r, "AttemptRecorded");
          if (prior) return attemptOk(prior);
        } catch (e) {
          return { ok: false, reason: `reconcile_failed: ${reasonOf(e)}` };
        }
      }
      const refusal = attemptRefusal(d, r);
      if (refusal) return { ok: false, reason: refusal };
      if (r.castle.vaultId == null) return { ok: false, reason: "no_vault" };
      try {
        const res = await vault.recordAttempt(
          {
            vaultId: BigInt(r.castle.vaultId),
            opId: opIdToBytes32(r.siege.id),
            operator: await accountEvmAddress(r.siege.raider),
            fee: BigInt(r.castle.feeTinybar),
          },
          recordPending(d, r.siege.id),
        );
        return attemptOk(res);
      } catch (err) {
        return recover(d, r, "AttemptRecorded", err, attemptOk);
      }
    },

    async release(siegeId: string, verdict: Verification & { signature: `0x${string}` }) {
      const d = getDb();
      const r = loadSettle(d, siegeId);
      if (!r.ok) return r;
      if (r.siege.pendingTx && !r.siege.releaseTx && !isFreeSiege(r)) {
        try {
          const prior = await settlePending(d, r, "Breached");
          if (prior) return releaseOk(prior);
        } catch (e) {
          return { ok: false, reason: `reconcile_failed: ${reasonOf(e)}` };
        }
      }
      const refusal = releaseRefusal(d, r) ?? verdictRefusal(r, verdict);
      if (refusal) return { ok: false, reason: refusal };
      try {
        const built = await buildRelease(r);
        if (!built.ok) return built;
        // The signature must cover exactly what we are about to send. If the raider address (or
        // anything else) resolved differently when it was signed, ask the worker to re-sign: retryable.
        let signer: string;
        try {
          signer = await recoverTypedDataAddress({ ...built.typedData, signature: verdict.signature });
        } catch {
          return { ok: false, reason: "bad_signature" };
        }
        if (signer.toLowerCase() !== verifierAddress().toLowerCase()) return { ok: false, reason: "stale_signature" };
        const res = await vault.release(
          {
            vaultId: built.typedData.message.vaultId,
            operator: built.operator,
            transcriptHash: built.typedData.message.transcriptHash,
            opId: built.typedData.message.opId,
            sig: verdict.signature,
            fee: BigInt(r.castle.feeTinybar),
          },
          recordPending(d, r.siege.id),
        );
        return releaseOk(res);
      } catch (err) {
        return recover(d, r, "Breached", err, releaseOk);
      }
    },

    async closeVault(vaultId: number, reason: VaultCloseReason) {
      const d = getDb();
      const tag = (env().VAULT_ADDRESS ?? "unset").toLowerCase();
      const castle = d
        .select()
        .from(schema.castles)
        .where(and(eq(schema.castles.vaultId, vaultId), eq(schema.castles.vaultAddress, tag)))
        .get();
      const refundSieges = () => (castle ? voidInFlightSieges(castle.id, closeVoidReason(reason), { includeEnded: true }).refunds : 0);
      try {
        const res = await vault.closeVault({ vaultId: BigInt(vaultId), reason });
        return { ok: true, tx: evmTx(res.txHash), refunded: res.refunded.toString(), inFlightRefunds: refundSieges() };
      } catch (err) {
        // A close that may have landed (timeout, or BadStatus because an earlier try did close it):
        // the vault's on-chain status decides. Closed = done (the pot already went back).
        if (err instanceof vault.VaultError && MAYBE_LANDED.has(err.errorName)) {
          try {
            const v = await vault.getVault(BigInt(vaultId));
            if (v.status === "Closed") {
              const ref = err.txHash ? evmTx(err.txHash) : { txId: `vault#${vaultId}:closed`, hashscanUrl: txUrl(vault.vaultAddress()) };
              return { ok: true, tx: ref, refunded: String(castle?.potTinybar ?? 0), inFlightRefunds: refundSieges() };
            }
          } catch (e) {
            return { ok: false, reason: `reconcile_failed: ${reasonOf(e)}` };
          }
        }
        return { ok: false, reason: reasonOf(err) };
      }
    },

    /** Queues the message in the HCS audit outbox; the worker's drainer submits it in order (lib/chain/outbox.ts). */
    async audit(event: SiegeEvent) {
      try {
        return enqueueAudit(getDb(), event, "testnet");
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      }
    },

    async createTopic(castleId: string) {
      try {
        const res = await hcs.createTopic(castleId);
        return { ok: true, topicId: res.topicId, tx: { txId: res.txId, hashscanUrl: txUrl(res.txId) } };
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      }
    },
  };
}

/** A write threw: if it (or an earlier try) actually landed, return that result; else map the error. */
async function recover<E extends "AttemptRecorded" | "Breached", T>(
  d: DB,
  r: SettleRows,
  eventName: E,
  err: unknown,
  ok: (x: E extends "AttemptRecorded" ? vault.AttemptResult : vault.ReleaseResult) => T,
): Promise<T | { ok: false; reason: string }> {
  const reason = reasonOf(err);
  if (!(err instanceof vault.VaultError) || !MAYBE_LANDED.has(err.errorName)) return { ok: false, reason };
  let found: (E extends "AttemptRecorded" ? vault.AttemptResult : vault.ReleaseResult) | "consumed_unindexed" | null;
  try {
    found = await landed(r, eventName, [err.txHash, r.siege.pendingTx], true);
  } catch (e) {
    // Could not check: keep the siege retryable, never treat it as refused.
    return { ok: false, reason: `reconcile_failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (found === "consumed_unindexed") return { ok: false, reason: "reconcile_pending" };
  if (found) return ok(found);
  if (err.errorName === "receipt_timeout") return { ok: false, reason: "receipt_timeout" };
  // Mined and reverted, and (landed checked it) the siege id is not consumed: nothing landed. Clear the
  // write-ahead marker so the next pass can refuse it (e.g. vault_not_open after a close) and refund it.
  if (err.errorName === "reverted" && err.txHash) {
    try {
      await clearRevertedPending(d, r, err.txHash);
    } catch {
      /* next pass re-checks the pending tx */
    }
  }
  return { ok: false, reason };
}

let shared: ChainPort | null = null;
export function testnetChain(): ChainPort {
  return (shared ??= createTestnetChain());
}

