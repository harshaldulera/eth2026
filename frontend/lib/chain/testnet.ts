import { eq } from "drizzle-orm";
import { recoverTypedDataAddress, type Hash } from "viem";
import { db as sharedDb, schema, type DB } from "@/lib/db";
import type { Amount, ChainPort, FeeSplit, SiegeEvent, TxRef, Verification } from "@/lib/types";
import { nowIso } from "@/lib/util/ids";
import { arenaAccount } from "./evm";
import { txUrl, isStubRef } from "./hashscan";
import * as hcs from "./hcs";
import { accountEvmAddress } from "./mirror";
import { siegeIdToBytes32, verifierAddress } from "./releaseSig";
import {
  attemptRefusal,
  auditCastle,
  auditMessage,
  buildRelease,
  isFreeSiege,
  loadSettle,
  releaseRefusal,
  verdictRefusal,
  type SettleRows,
} from "./settle";
import * as vault from "./vault";

/**
 * Real ChainPort: SiegeVault through the Hashio relay (viem) + HCS through the Hedera SDK.
 * Expected failures come back as { ok: false, reason }; nothing here throws to the caller.
 *
 * The one DB write: `sieges.pending_tx` is set right after a recordAttempt/release is broadcast and
 * before its receipt is awaited (write-ahead), so a receipt timeout, a relay hiccup or a worker crash
 * is reconciled from the chain on the next try instead of re-sending into Replay/BadStatus.
 * Reconciliation order: (1) the pending tx's receipt, (2) on Replay/BadStatus/receipt_timeout:
 * SiegeVault.siegeConsumed(id) and the AttemptRecorded/Broken log for that siege id (mirror node).
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

type AttemptOk = { ok: true; tx: TxRef; split: FeeSplit; newPot: Amount };
type ReleaseOk = { ok: true; tx: TxRef; amount: Amount };

const attemptOk = (a: vault.AttemptResult): AttemptOk => ({
  ok: true,
  tx: evmTx(a.txHash),
  split: { castellan: a.castellanCut.toString(), pot: a.potCut.toString(), arena: a.arenaCut.toString() },
  newPot: a.newPot.toString(),
});
const releaseOk = (a: vault.ReleaseResult): ReleaseOk => ({ ok: true, tx: evmTx(a.txHash), amount: a.amount.toString() });

/**
 * Did an earlier write for this siege land? Checks the tx hash we know about (pending_tx or the one in
 * the error), then — when the contract says the siege id is consumed — the event log for it.
 * Returns the result, "consumed_unindexed" (on chain but the mirror has no log yet: retry), or null.
 */
async function landed<E extends "AttemptRecorded" | "Broken">(
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
  const id = siegeIdToBytes32(r.siege.id);
  if (!(await vault.siegeConsumed(id))) return null;
  const since = Date.parse(r.siege.createdAt) || Date.now() - 6 * 86_400_000;
  const log = await vault.findSiegeLog(eventName, BigInt(r.castle.vaultId), id, since);
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

    async createVault(i: { castleId: string; pot: Amount; fee: Amount; durationSec: number; castellan: string }) {
      try {
        const res = await vault.createVault({
          fee: BigInt(i.fee),
          durationSec: BigInt(Math.floor(i.durationSec)),
          castellan: await castellanAddress(i.castellan),
          pot: BigInt(i.pot),
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
          const prior = await landed(r, "AttemptRecorded", [r.siege.pendingTx], false);
          if (prior && prior !== "consumed_unindexed") return attemptOk(prior);
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
            siegeId: siegeIdToBytes32(r.siege.id),
            raider: await accountEvmAddress(r.siege.raider),
            fee: BigInt(r.castle.feeTinybar),
          },
          recordPending(d, r.siege.id),
        );
        return attemptOk(res);
      } catch (err) {
        return recover(r, "AttemptRecorded", err, attemptOk);
      }
    },

    async release(siegeId: string, verdict: Verification & { signature: `0x${string}` }) {
      const d = getDb();
      const r = loadSettle(d, siegeId);
      if (!r.ok) return r;
      if (r.siege.pendingTx && !r.siege.releaseTx && !isFreeSiege(r)) {
        try {
          const prior = await landed(r, "Broken", [r.siege.pendingTx], false);
          if (prior && prior !== "consumed_unindexed") return releaseOk(prior);
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
            raider: built.raider,
            transcriptHash: built.typedData.message.transcriptHash,
            siegeId: built.typedData.message.siegeId,
            sig: verdict.signature,
            fee: BigInt(r.castle.feeTinybar),
          },
          recordPending(d, r.siege.id),
        );
        return releaseOk(res);
      } catch (err) {
        return recover(r, "Broken", err, releaseOk);
      }
    },

    async audit(event: SiegeEvent) {
      let d: DB;
      try {
        d = getDb();
      } catch (err) {
        return { ok: false, reason: reasonOf(err) };
      }
      const castle = auditCastle(d, event);
      if (!castle) return { ok: false, reason: "no_castle" };
      const message = auditMessage(event, castle.id);
      const row = (topicId: string, seq: number | null, txId: string | null) => {
        try {
          d.insert(schema.auditLog)
            .values({ topicId, castleId: castle.id, siegeId: event.siegeId || null, type: event.type, message, seq, txId, at: nowIso() })
            .run();
        } catch (err) {
          console.warn("[chain] auditLog insert failed", err);
        }
      };
      if (!castle.topicId) {
        row("none", null, null);
        return { ok: false, reason: "no_topic" };
      }
      try {
        const res = await hcs.submit(castle.topicId, message);
        row(castle.topicId, res.seq, res.txId);
        return { ok: true, topicId: castle.topicId, seq: res.seq };
      } catch (err) {
        row(castle.topicId, null, null);
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
async function recover<E extends "AttemptRecorded" | "Broken", T>(
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
  return { ok: false, reason };
}

let shared: ChainPort | null = null;
export function testnetChain(): ChainPort {
  return (shared ??= createTestnetChain());
}

