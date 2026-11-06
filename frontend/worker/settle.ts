import { and, asc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import { chain, formatHbar, prepareRelease } from "@/lib/chain";
import { titleFor } from "@/lib/castles";
import { db, schema } from "@/lib/db";
import { MAX_CHAIN_ATTEMPTS } from "@/lib/db/schema";
import { emit } from "@/lib/events/bus";
import { reconcileReceipts, voidSiege, voidStrandedSieges } from "@/lib/pay/refunds";
import { verifier } from "@/lib/siege";
import type { TxRef } from "@/lib/types";
import { nowIso } from "@/lib/util/ids";
import { log } from "./log";
import { signReleaseTypedData } from "./signer";

/**
 * Settlement: apply chain results for every ended siege the worker has not settled yet.
 *
 *   paid held/banished -> chain.recordAttempt -> sieges.attemptTx; castle pot = newPot, streak+1, title
 *   paid broken        -> verifier.verify -> prepareRelease -> sign (verifier key) -> chain.release
 *                         -> sieges.releaseTx/releaseAmount; castle broken, pot 0
 *   free held/banished -> no money and no streak (free sieges are unlimited per wallet string, so they
 *                         must not move the public record); "attempt" event { free: true }
 *   free broken        -> castle stays open (a free break never wins the pot); "release" event { free: true }
 *   castle closed under a paid siege (vault_not_open / expired) -> the siege is void, its fee refunded
 *
 * One bad row never stops the loop: the error goes to sieges.chainError, chainAttempts+1, retried
 * with backoff, abandoned after MAX_CHAIN_ATTEMPTS (or at once for refusals that cannot change).
 * A write that may have landed is never re-sent blind: the testnet ChainPort reconciles it from
 * sieges.pending_tx / the contract first (lib/chain/testnet.ts).
 * Each pass also voids in-progress sieges stranded on closed castles and runs receipt
 * reconciliation + refunds (lib/pay/refunds.ts).
 */

export { MAX_CHAIN_ATTEMPTS };

/** Refusals after which the castle can no longer pay this siege: void it and refund the fee. */
const VOIDABLE = new Set(["vault_not_open", "expired"]);

/** Refusals that retrying cannot fix. */
const PERMANENT = new Set([
  "free_siege",
  "bad_status",
  "no_receipt",
  "underpaid",
  "vault_not_open",
  "expired",
  "no_transcript",
  "siege_mismatch",
  "not_verified",
  "transcript_mismatch",
  "no_vault",
  "siege_not_found",
  "castle_not_found",
  "bad_signature",
  "void",
  // contract errors (lib/chain/testnet.ts maps the custom error names)
  "already_consumed",
  "wrong_fee",
  "not_arena",
  "bad_args",
  "not_allowed",
  "chain_id_mismatch",
  "stub_receipt",
]);

const S = schema.sieges;
const C = schema.castles;
type SiegeRow = typeof schema.sieges.$inferSelect;

const g = globalThis as unknown as { __siegeSettleBackoff?: Map<string, number> };
const nextTry = (g.__siegeSettleBackoff ??= new Map<string, number>());

const short = (id: string) => id.replace(/^siege_/, "").slice(0, 8);

function castleName(id: string): string {
  return db().select({ n: C.name }).from(C).where(eq(C.id, id)).get()?.n ?? id;
}

/** The castle can no longer pay this siege (another raider won it, or it closed/expired). */
function voidOrFail(row: SiegeRow, reason: string): void {
  if (!row.free && !row.pendingTx && voidSiege(row.id, reason)) {
    log.fail(`settle ${short(row.id)} (${row.status}): ${reason} — siege void, fee queued for refund`);
    return;
  }
  fail(row, reason, true);
}

function fail(row: SiegeRow, reason: string, permanent: boolean) {
  const attempts = permanent ? MAX_CHAIN_ATTEMPTS : row.chainAttempts + 1;
  db().update(S).set({ chainError: reason.slice(0, 500), chainAttempts: attempts }).where(eq(S.id, row.id)).run();
  const giveUp = attempts >= MAX_CHAIN_ATTEMPTS;
  if (!giveUp) nextTry.set(row.id, Date.now() + 1000 * 2 ** attempts);
  log.fail(`settle ${short(row.id)} (${row.status}${row.free ? ", free" : ""}): ${reason}${giveUp ? " — giving up" : ` — retry ${attempts}/${MAX_CHAIN_ATTEMPTS}`}`);
}

const txPayload = (tx: TxRef) => ({ tx, txId: tx.txId, hashscanUrl: tx.hashscanUrl, stub: tx.stub === true });

async function settleHeld(row: SiegeRow) {
  if (row.attemptTx) {
    // Chain write landed but we crashed before marking it settled.
    db().update(S).set({ settledAt: nowIso() }).where(eq(S.id, row.id)).run();
    return;
  }
  const r = await chain.recordAttempt(row.id);
  if (!r.ok) {
    if (VOIDABLE.has(r.reason)) return voidOrFail(row, r.reason);
    return fail(row, r.reason, PERMANENT.has(r.reason) || r.reason === "already_released");
  }
  const at = nowIso();
  const castle = db().transaction((tx) => {
    tx.update(S).set({ attemptTx: r.tx.txId, pendingTx: null, chainError: null, settledAt: at }).where(eq(S.id, row.id)).run();
    const c = tx
      .update(C)
      .set({ potTinybar: Number(r.newPot), streak: sql`${C.streak} + 1` })
      .where(eq(C.id, row.castleId))
      .returning()
      .get();
    tx.update(C).set({ title: titleFor(c.streak) }).where(eq(C.id, c.id)).run();
    return c;
  });
  emit({
    siegeId: row.id,
    castleId: row.castleId,
    type: "attempt",
    payload: {
      castleId: row.castleId,
      split: r.split,
      newPot: r.newPot,
      streak: castle.streak,
      agentId: row.agentId ?? undefined,
      ...txPayload(r.tx),
    },
  });
  await chain.audit({ siegeId: row.id, castleId: row.castleId, type: "attempt", payload: { txId: r.tx.txId }, at });
  log.ok(
    `attempt ${short(row.id)} @ ${castle.name}: ${row.status}, pot +${formatHbar(BigInt(r.split.pot))} -> ${formatHbar(BigInt(r.newPot))}, streak ${castle.streak} (${r.tx.txId})`,
  );
}

async function settleBroken(row: SiegeRow) {
  if (row.releaseTx) {
    db().update(S).set({ settledAt: nowIso() }).where(eq(S.id, row.id)).run();
    return;
  }
  const v = await verifier.verify(row.id);
  if (!v.ok) return fail(row, `verify:${v.reason ?? "failed"}`, true);
  const prep = await prepareRelease(row.id);
  if (!prep.ok) {
    if (VOIDABLE.has(prep.reason)) return voidOrFail(row, prep.reason);
    return fail(row, prep.reason, PERMANENT.has(prep.reason));
  }
  // Sign exactly what prepareRelease built; chain.release re-checks the signature against the Release
  // it is about to send ("stale_signature", retryable, if anything resolved differently meanwhile).
  const signature = await signReleaseTypedData(prep.typedData);
  const r = await chain.release(row.id, { ...v, signature });
  if (!r.ok) {
    if (VOIDABLE.has(r.reason)) return voidOrFail(row, r.reason);
    return fail(row, r.reason, PERMANENT.has(r.reason) || r.reason === "already_recorded");
  }
  const at = nowIso();
  db().transaction((tx) => {
    tx.update(S)
      .set({ releaseTx: r.tx.txId, releaseAmountTinybar: Number(r.amount), pendingTx: null, chainError: null, settledAt: at })
      .where(eq(S.id, row.id))
      .run();
    tx.update(C).set({ status: "broken", potTinybar: 0 }).where(eq(C.id, row.castleId)).run();
  });
  // Anyone still mid-siege on this castle can no longer win anything: void them, refund their fees.
  for (const id of voidStrandedSieges()) log.info(`siege ${short(id)} void — its castle fell, fee queued for refund`);
  emit({
    siegeId: row.id,
    castleId: row.castleId,
    type: "release",
    payload: {
      castleId: row.castleId,
      amount: r.amount,
      raider: row.raider,
      raiderEvm: prep.raider,
      vaultId: prep.vaultId,
      agentId: row.agentId ?? undefined,
      ...txPayload(r.tx),
    },
  });
  await chain.audit({
    siegeId: row.id,
    castleId: row.castleId,
    type: "release",
    payload: { txId: r.tx.txId, transcriptHash: v.transcriptHash, requestId: v.requestId },
    at,
  });
  log.ok(`release ${short(row.id)} @ ${castleName(row.castleId)}: ${formatHbar(BigInt(r.amount))} -> ${row.raider} (${r.tx.txId})`);
}

function settleFree(row: SiegeRow) {
  const at = nowIso();
  if (row.status === "broken") {
    db().update(S).set({ settledAt: at, chainError: null }).where(eq(S.id, row.id)).run();
    emit({
      siegeId: row.id,
      castleId: row.castleId,
      type: "release",
      payload: { castleId: row.castleId, free: true, amount: "0", raider: row.raider, title: "Breaker (practice)" },
    });
    log.ok(`free break ${short(row.id)} @ ${castleName(row.castleId)}: practice only, castle stays open, no payout`);
    return;
  }
  // held / banished: practice only. Free sieges are keyed by an unproven wallet string, so they are
  // effectively unlimited: they must not move the castle's public streak/title (paid sieges do).
  db().update(S).set({ settledAt: at, chainError: null }).where(eq(S.id, row.id)).run();
  const streak = db().select({ s: C.streak }).from(C).where(eq(C.id, row.castleId)).get()?.s ?? 0;
  emit({ siegeId: row.id, castleId: row.castleId, type: "attempt", payload: { castleId: row.castleId, free: true, streak } });
  log.ok(`free ${row.status} ${short(row.id)} @ ${castleName(row.castleId)}: practice defense, streak unchanged (${streak}), no money`);
}

/** Ended sieges the worker still has to settle, oldest end first (a held siege lands before a later break). */
function pending(): SiegeRow[] {
  return db()
    .select()
    .from(S)
    .where(
      and(inArray(S.status, ["held", "banished", "broken"]), isNull(S.settledAt), isNull(S.voidReason), lt(S.chainAttempts, MAX_CHAIN_ATTEMPTS)),
    )
    .orderBy(asc(S.endedAt), asc(S.createdAt))
    .limit(50)
    .all();
}

/** One settlement pass. Returns how many sieges / receipts it acted on. */
export async function settleTick(): Promise<number> {
  let n = 0;
  for (const id of voidStrandedSieges()) {
    n++;
    log.info(`siege ${short(id)} void — its castle closed under it, fee queued for refund`);
  }
  for (const row of pending()) {
    const due = nextTry.get(row.id);
    if (due && due > Date.now()) continue;
    nextTry.delete(row.id);
    n++;
    try {
      if (row.free) settleFree(row);
      else if (row.status === "broken") await settleBroken(row);
      else await settleHeld(row);
    } catch (e) {
      fail(row, e instanceof Error ? e.message : String(e), false);
    }
  }
  try {
    const rep = await reconcileReceipts();
    for (const r of rep.resolved) log.info(`receipt ${r.id}: ambiguous settlement resolved -> ${r.state}`);
    for (const r of rep.refunded) log.ok(`refund ${r.id} sent (${r.txId})`);
    for (const r of rep.failed) log.fail(`refund ${r.id} FAILED — needs an operator: ${r.error}`);
    n += rep.resolved.length + rep.refunded.length + rep.failed.length;
  } catch (e) {
    log.fail(`receipt reconciliation: ${e instanceof Error ? e.message : String(e)}`);
  }
  return n;
}
