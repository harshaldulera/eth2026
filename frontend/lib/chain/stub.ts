import { eq, max } from "drizzle-orm";
import { recoverTypedDataAddress } from "viem";
import { db as sharedDb, schema, type DB } from "@/lib/db";
import type { Amount, ChainPort, SiegeEvent, TxRef, Verification } from "@/lib/types";
import { nowIso } from "@/lib/util/ids";
import { txUrl } from "./hashscan";
import { verifierAddress } from "./releaseSig";
import {
  attemptRefusal,
  auditCastle,
  auditMessage,
  buildRelease,
  computeSplit,
  loadSettle,
  releaseRefusal,
  splitToAmounts,
  verdictRefusal,
} from "./settle";

/**
 * Stub ChainPort: no network. Applies the same refusal rules and the same integer fee math as
 * SiegeVault, verifies release signatures against verifierAddress(), and keeps the HCS audit log
 * in the auditLog table. Like the real port it never writes castles/sieges: the worker does.
 */

const g = globalThis as unknown as { __siegeStubTx?: number; __siegeStubVault?: number };

export function stubTx(): TxRef {
  g.__siegeStubTx = (g.__siegeStubTx ?? 0) + 1;
  const txId = `stub:0.0.0@${Date.now()}.${g.__siegeStubTx}`;
  return { txId, hashscanUrl: txUrl(txId), stub: true };
}

export const stubTopicId = (castleId: string) => `0.0.stub-${castleId}`;

export function createStubChain(getDb: () => DB = sharedDb): ChainPort {
  return {
    mode: "stub",

    async createVault(i: { castleId: string; pot: Amount; fee: Amount; durationSec: number; castellan: string }) {
      let pot: bigint, fee: bigint;
      try {
        pot = BigInt(i.pot);
        fee = BigInt(i.fee);
      } catch {
        return { ok: false, reason: "bad_args" };
      }
      if (pot <= BigInt(0) || fee <= BigInt(0) || !(i.durationSec > 0) || !i.castellan) return { ok: false, reason: "bad_args" };
      const dbMax = getDb().select({ m: max(schema.castles.vaultId) }).from(schema.castles).get()?.m ?? 0;
      const vaultId = Math.max(dbMax, g.__siegeStubVault ?? 0) + 1;
      g.__siegeStubVault = vaultId;
      return { ok: true, vaultId, tx: stubTx() };
    },

    async recordAttempt(siegeId: string) {
      const d = getDb();
      const r = loadSettle(d, siegeId);
      if (!r.ok) return r;
      const refusal = attemptRefusal(d, r);
      if (refusal) return { ok: false, reason: refusal };
      const fee = BigInt(r.castle.feeTinybar);
      const split = computeSplit(fee);
      const newPot = BigInt(r.castle.potTinybar) + split.pot;
      return { ok: true, tx: stubTx(), split: splitToAmounts(split), newPot: newPot.toString() };
    },

    async release(siegeId: string, verdict: Verification & { signature: `0x${string}` }) {
      const d = getDb();
      const r = loadSettle(d, siegeId);
      if (!r.ok) return r;
      const refusal = releaseRefusal(d, r) ?? verdictRefusal(r, verdict);
      if (refusal) return { ok: false, reason: refusal };
      const built = await buildRelease(r);
      if (!built.ok) return built;
      let signer: string;
      try {
        signer = await recoverTypedDataAddress({ ...built.typedData, signature: verdict.signature });
      } catch {
        return { ok: false, reason: "bad_signature" };
      }
      if (signer.toLowerCase() !== verifierAddress().toLowerCase()) return { ok: false, reason: "bad_signature" };
      const amount = BigInt(r.castle.potTinybar) + BigInt(r.castle.feeTinybar);
      return { ok: true, tx: stubTx(), amount: amount.toString() };
    },

    async audit(event: SiegeEvent) {
      try {
        const d = getDb();
        const castle = auditCastle(d, event);
        if (!castle) return { ok: false, reason: "no_castle" };
        const topicId = castle.topicId ?? stubTopicId(castle.id);
        const message = auditMessage(event, castle.id);
        const seq = d.transaction((tx) => {
          const last = tx.select({ m: max(schema.auditLog.seq) }).from(schema.auditLog).where(eq(schema.auditLog.topicId, topicId)).get()?.m ?? 0;
          const next = last + 1;
          tx.insert(schema.auditLog)
            .values({
              topicId,
              castleId: castle.id,
              siegeId: event.siegeId || null,
              type: event.type,
              message,
              seq: next,
              txId: null,
              at: nowIso(),
            })
            .run();
          return next;
        });
        return { ok: true, topicId, seq };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async createTopic(castleId: string) {
      return { ok: true, topicId: stubTopicId(castleId), tx: stubTx() };
    },
  };
}

let shared: ChainPort | null = null;
/** The stub port on the shared DB handle. */
export function stubChain(): ChainPort {
  return (shared ??= createStubChain());
}
