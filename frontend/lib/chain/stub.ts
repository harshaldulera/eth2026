import { and, eq, isNull, max, or } from "drizzle-orm";
import { recoverTypedDataAddress } from "viem";
import { db as sharedDb, schema, type DB } from "@/lib/db";
import { voidInFlightSieges } from "@/lib/pay/refunds";
import type { Amount, ChainPort, SiegeEvent, TxRef, VaultCloseReason, Verification } from "@/lib/types";
import { nowIso } from "@/lib/util/ids";
import { txUrl } from "./hashscan";
import { verifierAddress } from "./releaseSig";
import {
  attemptRefusal,
  auditCastle,
  auditMessage,
  auditType,
  buildRelease,
  closeVoidReason,
  computeSplit,
  isFreeSiege,
  loadSettle,
  releaseRefusal,
  splitToAmounts,
  validProtectedTool,
  VAULT_OPEN_STATES,
  verdictRefusal,
} from "./settle";

/**
 * Stub ChainPort: no network. Applies the same refusal rules and the same integer fee math as
 * SiegeVault, verifies release signatures against verifierAddress(), and keeps the HCS audit log
 * in the auditLog table. Like the real port, its only DB write is the write-ahead `sieges.pending_tx`
 * of a recordAttempt/release (so a vault close racing the worker cannot void a siege whose chain write
 * already "landed"); castles and settlement results are written by the worker.
 */

const g = globalThis as unknown as {
  __siegeStubTx?: number;
  __siegeStubVault?: number;
  __siegeStubVaultTools?: Map<number, string>;
  __siegeStubClosed?: WeakMap<DB, Set<number>>;
};
const vaultTools = (g.__siegeStubVaultTools ??= new Map<number, string>());
/** Vaults closed on the stub "chain", per database (a fresh DB restarts vault ids at 1; its vaults are not closed). */
const closedByDb = (g.__siegeStubClosed instanceof WeakMap ? g.__siegeStubClosed : (g.__siegeStubClosed = new WeakMap<DB, Set<number>>()));
const closedVaults = (d: DB): Set<number> => {
  let set = closedByDb.get(d);
  if (!set) closedByDb.set(d, (set = new Set<number>()));
  return set;
};

/** A stub write that already "landed" for this siege (its pending_tx), as a TxRef. */
const landedStub = (r: { siege: { pendingTx: string | null } }): TxRef | null =>
  r.siege.pendingTx?.startsWith("stub:") ? { txId: r.siege.pendingTx, hashscanUrl: txUrl(r.siege.pendingTx), stub: true } : null;

/** Write-ahead marker, like the testnet port's pending_tx: a siege with a chain write in flight is never voided. */
const markPending = (d: DB, siegeId: string, tx: TxRef) =>
  d.update(schema.sieges).set({ pendingTx: tx.txId }).where(eq(schema.sieges.id, siegeId)).run();

/** The protectedTool a stub vault was created with (this process only; the castle row has it too). */
export const stubVaultTool = (vaultId: number): string | undefined => vaultTools.get(vaultId);



export function stubTx(): TxRef {
  g.__siegeStubTx = (g.__siegeStubTx ?? 0) + 1;
  const txId = `stub:0.0.0@${Date.now()}.${g.__siegeStubTx}`;
  return { txId, hashscanUrl: txUrl(txId), stub: true };
}

export const stubTopicId = (castleId: string) => `0.0.stub-${castleId}`;

export function createStubChain(getDb: () => DB = sharedDb): ChainPort {
  return {
    mode: "stub",

    async createVault(i: { castleId: string; pot: Amount; fee: Amount; durationSec: number; castellan: string; protectedTool: string }) {
      let pot: bigint, fee: bigint;
      try {
        pot = BigInt(i.pot);
        fee = BigInt(i.fee);
      } catch {
        return { ok: false, reason: "bad_args" };
      }
      if (pot <= BigInt(0) || fee <= BigInt(0) || !(i.durationSec > 0) || !i.castellan) return { ok: false, reason: "bad_args" };
      if (!validProtectedTool(i.protectedTool)) return { ok: false, reason: "bad_args" };
      const dbMax = getDb().select({ m: max(schema.castles.vaultId) }).from(schema.castles).get()?.m ?? 0;
      const vaultId = Math.max(dbMax, g.__siegeStubVault ?? 0) + 1;
      g.__siegeStubVault = vaultId;
      vaultTools.set(vaultId, i.protectedTool);
      return { ok: true, vaultId, tx: stubTx() };
    },

    /**
     * Mirrors SiegeVault.closeVault: the vault must be Open (castle open, vault funded/guarding/dormant),
     * "expired" needs the deadline to have passed; the arena may close for any reason. The pot goes back
     * to the castellan; every in-flight paid siege on the castle is voided and queued for refund.
     * Like the real port it does not touch castles (the caller transitions the vault state).
     */
    async closeVault(vaultId: number, reason: VaultCloseReason) {
      const d = getDb();
      const C = schema.castles;
      const castle = d
        .select()
        .from(C)
        .where(and(eq(C.vaultId, vaultId), or(eq(C.vaultAddress, "stub"), isNull(C.vaultAddress))))
        .get();
      if (!castle || closedVaults(d).has(vaultId) || castle.status !== "open" || !VAULT_OPEN_STATES.has(castle.vaultState))
        return { ok: false, reason: "vault_not_open" };
      if (reason === "expired" && castle.deadline > Date.now()) return { ok: false, reason: "not_expired" };
      closedVaults(d).add(vaultId);
      const voided = voidInFlightSieges(castle.id, closeVoidReason(reason), { includeEnded: true });
      return { ok: true, tx: stubTx(), refunded: String(castle.potTinybar), inFlightRefunds: voided.refunds };
    },

    async recordAttempt(siegeId: string) {
      const d = getDb();
      const r = loadSettle(d, siegeId);
      if (!r.ok) return r;
      // An earlier call "landed" (pending_tx written) but the worker never applied it: that write stands,
      // like a landed testnet tx wins over a later DB-level refusal (e.g. the vault closed since).
      const prior = landedStub(r);
      if (prior && !r.siege.attemptTx && !isFreeSiege(r)) {
        const split = computeSplit(BigInt(r.castle.feeTinybar));
        return { ok: true, tx: prior, split: splitToAmounts(split), newPot: (BigInt(r.castle.potTinybar) + split.pot).toString() };
      }
      const refusal = attemptRefusal(d, r);
      if (refusal) return { ok: false, reason: refusal };
      const fee = BigInt(r.castle.feeTinybar);
      const split = computeSplit(fee);
      const newPot = BigInt(r.castle.potTinybar) + split.pot;
      const tx = stubTx();
      markPending(d, siegeId, tx);
      return { ok: true, tx, split: splitToAmounts(split), newPot: newPot.toString() };
    },

    async release(siegeId: string, verdict: Verification & { signature: `0x${string}` }) {
      const d = getDb();
      const r = loadSettle(d, siegeId);
      if (!r.ok) return r;
      const prior = landedStub(r);
      if (prior && !r.siege.releaseTx && !isFreeSiege(r)) return { ok: true, tx: prior, amount: (BigInt(r.castle.potTinybar) + BigInt(r.castle.feeTinybar)).toString() };
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
      const tx = stubTx();
      markPending(d, siegeId, tx);
      return { ok: true, tx, amount: amount.toString() };
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
              type: auditType(event),
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
