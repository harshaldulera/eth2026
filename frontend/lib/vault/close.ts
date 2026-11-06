import { eq } from "drizzle-orm";
import { pendingPaidBreak } from "@/lib/castles";
import { chain } from "@/lib/chain";
import { closeVoidReason, VAULT_OPEN_STATES } from "@/lib/chain/settle";
import { db, schema } from "@/lib/db";
import { voidInFlightSieges } from "@/lib/pay/refunds";
import type { Amount, TxRef, VaultCloseReason } from "@/lib/types";
import { TERMINAL_STATES, transitionVault, type TransitionOpts } from "./state";

const C = schema.castles;

export type CloseResult =
  | { ok: true; tx: TxRef | null; refunded: Amount; inFlightRefunds: number }
  | { ok: false; reason: string; status: 404 | 409 | 502 };

/**
 * THE way to close a vault, and the cross-lane close interface: Lane B's orders-changed hook calls
 * closeCastle(castleId, "orders_changed") (or vaultState.transition(castleId, "closed", "orders_changed"),
 * which routes here). chain.closeVault on its own is Lane A internal: it does not take the castle off
 * the board.
 *
 * In order:
 *   1. refuse while a paid break waits for its release (409 "being_broken": that pot is the raider's;
 *      the worker releases it within a pass and the castle ends "broken" instead);
 *   2. funded vaults: void every siege still in progress (no siege can end broken while the close is
 *      mining; paid fees go refund_due), then SiegeVault.closeVault returns the pot to the castellan
 *      (the ChainPort also voids ended-unsettled held/banished sieges), then pot 0;
 *   3. the "closed" transition with the reason. A castle that was never funded only transitions.
 * "expired" needs the deadline to have passed (the contract checks it too).
 */
export async function closeCastle(castleId: string, reason: VaultCloseReason, opts: Pick<TransitionOpts, "awaitSideEffects"> & { now?: number } = {}): Promise<CloseResult> {
  const row = db().select().from(C).where(eq(C.id, castleId)).get();
  if (!row) return { ok: false, reason: "not_found", status: 404 };
  if (TERMINAL_STATES.has(row.vaultState)) return { ok: false, reason: "illegal_transition", status: 409 };
  if (reason === "expired" && row.deadline > (opts.now ?? Date.now())) return { ok: false, reason: "not_expired", status: 409 };
  if (pendingPaidBreak(castleId)) return { ok: false, reason: "being_broken", status: 409 };

  let tx: TxRef | null = null;
  let refunded: Amount = "0";
  let inFlightRefunds = 0;
  const onChain = row.vaultId != null && row.status === "open" && VAULT_OPEN_STATES.has(row.vaultState);
  if (onChain) {
    // Stop play before the (on testnet, seconds-long) close: a siege that ended broken while the close
    // mined would find its release refused. If the close then fails, those raiders still get their fee back.
    const early = voidInFlightSieges(castleId, closeVoidReason(reason));
    const r = await chain.closeVault(row.vaultId!, reason);
    if (!r.ok) return { ok: false, reason: r.reason, status: r.reason === "not_expired" || r.reason === "vault_not_open" ? 409 : 502 };
    tx = r.tx;
    refunded = r.refunded;
    inFlightRefunds = early.refunds + r.inFlightRefunds;
    db().update(C).set({ potTinybar: 0 }).where(eq(C.id, castleId)).run();
  }
  const t = await transitionVault(castleId, "closed", reason, { awaitSideEffects: opts.awaitSideEffects });
  if (!t.ok) return { ok: false, reason: t.reason, status: t.reason === "not_found" ? 404 : 409 };
  return { ok: true, tx, refunded, inFlightRefunds };
}

const g = globalThis as unknown as { __siegeCloseBackoff?: Map<string, number> };
const backoff = (g.__siegeCloseBackoff ??= new Map<string, number>());

/**
 * Worker: every non-terminal castle past its deadline closes as "expired" (funded vaults on chain,
 * the pot back to the castellan). A castle with a paid break waiting for its release is skipped: the
 * release pays the raider and the castle ends "broken". Failures are retried with a 30s backoff.
 * Returns what it closed.
 */
export async function closeExpiredVaults(now = Date.now()): Promise<{ closed: { castleId: string; name: string; refunded: Amount; inFlightRefunds: number; tx: TxRef | null }[]; failed: { castleId: string; reason: string }[] }> {
  const out = { closed: [] as { castleId: string; name: string; refunded: Amount; inFlightRefunds: number; tx: TxRef | null }[], failed: [] as { castleId: string; reason: string }[] };
  const rows = db().select({ id: C.id, name: C.name, deadline: C.deadline, vaultState: C.vaultState }).from(C).all();
  for (const c of rows) {
    if (TERMINAL_STATES.has(c.vaultState) || c.deadline > now) continue;
    if (pendingPaidBreak(c.id)) continue;
    const due = backoff.get(c.id);
    if (due && due > now) continue;
    const r = await closeCastle(c.id, "expired", { now });
    if (r.ok) {
      backoff.delete(c.id);
      out.closed.push({ castleId: c.id, name: c.name, refunded: r.refunded, inFlightRefunds: r.inFlightRefunds, tx: r.tx });
    } else {
      backoff.set(c.id, now + 30_000);
      out.failed.push({ castleId: c.id, reason: r.reason });
    }
  }
  return out;
}
