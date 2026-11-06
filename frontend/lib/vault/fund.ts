import { and, eq, isNull, or } from "drizzle-orm";
import { chain, formatHbar, vaultTag } from "@/lib/chain";
import { db, schema } from "@/lib/db";
import type { TxRef } from "@/lib/types";
import { transitionVault, type TransitionOpts } from "./state";

const C = schema.castles;

export const DEFAULT_VAULT_DAYS = 3;

/** castles.create_vault_tx while a createVault is in flight (claimed by exactly one caller). */
export const FUNDING_MARKER = "pending:";
/** Outcomes after which the createVault may already be on chain: keep the marker, never re-send by itself. */
const MAYBE_LANDED = /^(receipt_timeout|rpc_error|Replay|BadStatus|reverted)\b/;

export type FundResult = { ok: true; vaultId: number; tx: TxRef; reason: string } | { ok: false; reason: string };

/**
 * verified -> funded: SiegeVault.createVault(fee, duration, castellan, protectedTool) with the pot as
 * value, the castle row pointed at the new vault (vault id, which contract, tx, deadline), then the
 * "funded" transition. The castle must be "verified" (its guardian passed its checks first).
 */
export async function fundVault(
  castleId: string,
  opts: { potTinybar?: number; durationSec?: number } & Pick<TransitionOpts, "awaitSideEffects"> = {},
): Promise<FundResult> {
  const row = db().select().from(C).where(eq(C.id, castleId)).get();
  if (!row) return { ok: false, reason: "not_found" };
  if (row.vaultState !== "verified") return { ok: false, reason: "illegal_transition" };
  if (row.createVaultTx?.startsWith(FUNDING_MARKER)) return { ok: false, reason: "fund_in_progress" };
  // Claim the castle before the awaited createVault, so two callers (the /open button and a deposit
  // handler, or two processes) can never both create an arena-funded vault for it.
  const claimedAt = Date.now();
  const claim = db()
    .update(C)
    .set({ createVaultTx: `${FUNDING_MARKER}${claimedAt}` })
    .where(and(eq(C.id, castleId), eq(C.vaultState, "verified"), or(isNull(C.createVaultTx), eq(C.createVaultTx, row.createVaultTx ?? ""))))
    .run();
  if (claim.changes !== 1) return { ok: false, reason: "fund_in_progress" };
  const release = () =>
    db()
      .update(C)
      .set({ createVaultTx: row.createVaultTx ?? null })
      .where(and(eq(C.id, castleId), eq(C.createVaultTx, `${FUNDING_MARKER}${claimedAt}`)))
      .run();
  const pot = opts.potTinybar ?? row.potTinybar;
  const durationSec = opts.durationSec ?? DEFAULT_VAULT_DAYS * 24 * 60 * 60;
  let r: Awaited<ReturnType<typeof chain.createVault>>;
  try {
    r = await chain.createVault({
      castleId,
      pot: String(pot),
      fee: String(row.feeTinybar),
      durationSec,
      castellan: row.owner,
      protectedTool: row.protectedTool,
    });
  } catch (e) {
    // Unknown outcome: keep the claim (an operator checks the chain before funding this castle again).
    return { ok: false, reason: `fund_in_doubt: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!r.ok) {
    if (MAYBE_LANDED.test(r.reason)) return { ok: false, reason: `fund_in_doubt: ${r.reason}` };
    release();
    return r;
  }
  // The contract's deadline is now + duration: keep the DB in step.
  db()
    .update(C)
    .set({ vaultId: r.vaultId, vaultAddress: vaultTag(), createVaultTx: r.tx.txId, potTinybar: pot, deadline: Date.now() + durationSec * 1000 })
    .where(eq(C.id, castleId))
    .run();
  const reason = `vault #${r.vaultId} funded with ${formatHbar(BigInt(pot))}`;
  const t = await transitionVault(castleId, "funded", reason, { awaitSideEffects: opts.awaitSideEffects });
  if (!t.ok) {
    // Someone moved the castle meanwhile (e.g. closed it): the vault exists on chain but the castle is not funded.
    console.warn(`[vault] ${castleId}: vault #${r.vaultId} created but the funded transition failed (${t.reason})`);
    return { ok: false, reason: t.reason };
  }
  return { ok: true, vaultId: r.vaultId, tx: r.tx, reason };
}
