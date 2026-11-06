import { eq } from "drizzle-orm";
import { chain } from "@/lib/chain";
import { VAULT_OPEN_STATES } from "@/lib/chain/settle";
import { db, schema } from "@/lib/db";
import type { Amount, TxRef, VaultCloseReason } from "@/lib/types";
import { TERMINAL_STATES, transitionVault, type TransitionOpts } from "./state";

const C = schema.castles;

export type CloseResult =
  | { ok: true; tx: TxRef | null; refunded: Amount; inFlightRefunds: number }
  | { ok: false; reason: string; status: 404 | 409 | 502 };

/**
 * Close a castle's vault: on chain first (SiegeVault.closeVault returns the pot to the castellan; the
 * ChainPort voids every in-flight siege and queues each paid fee for refund), then pot 0 and the
 * "closed" transition with the close reason. A castle that was never funded only transitions.
 * "expired" needs the deadline to have passed (the contract checks it too).
 */
export async function closeCastle(castleId: string, reason: VaultCloseReason, opts: Pick<TransitionOpts, "awaitSideEffects"> & { now?: number } = {}): Promise<CloseResult> {
  const row = db().select().from(C).where(eq(C.id, castleId)).get();
  if (!row) return { ok: false, reason: "not_found", status: 404 };
  if (TERMINAL_STATES.has(row.vaultState)) return { ok: false, reason: "illegal_transition", status: 409 };
  if (reason === "expired" && row.deadline > (opts.now ?? Date.now())) return { ok: false, reason: "not_expired", status: 409 };

  let tx: TxRef | null = null;
  let refunded: Amount = "0";
  let inFlightRefunds = 0;
  const onChain = row.vaultId != null && row.status === "open" && VAULT_OPEN_STATES.has(row.vaultState);
  if (onChain) {
    const r = await chain.closeVault(row.vaultId!, reason);
    if (!r.ok) return { ok: false, reason: r.reason, status: r.reason === "not_expired" || r.reason === "vault_not_open" ? 409 : 502 };
    tx = r.tx;
    refunded = r.refunded;
    inFlightRefunds = r.inFlightRefunds;
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
 * the pot back to the castellan). Failures are retried with a 30s backoff. Returns what it closed.
 */
export async function closeExpiredVaults(now = Date.now()): Promise<{ closed: { castleId: string; name: string; refunded: Amount; inFlightRefunds: number; tx: TxRef | null }[]; failed: { castleId: string; reason: string }[] }> {
  const out = { closed: [] as { castleId: string; name: string; refunded: Amount; inFlightRefunds: number; tx: TxRef | null }[], failed: [] as { castleId: string; reason: string }[] };
  const rows = db().select({ id: C.id, name: C.name, deadline: C.deadline, vaultState: C.vaultState }).from(C).all();
  for (const c of rows) {
    if (TERMINAL_STATES.has(c.vaultState) || c.deadline > now) continue;
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
