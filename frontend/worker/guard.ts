import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { leaseLive, LEASE_TTL_MS } from "@/lib/guard/lease";
import { expireStale } from "@/lib/guard/turns";
import type { VaultState } from "@/lib/types";
import { closeCastle, transitionVault } from "@/lib/vault";
import { log } from "./log";

/**
 * Part 2a SDK guard monitor (plan §2A), every second from worker/index.ts:
 *  1. expire guard turns nobody will answer;
 *  2. guarding SDK vault whose harness holds a lease but has not polled for 30 s → dormant (voids
 *     live ops and refunds their fees, lib/vault/state); a funded or dormant one whose harness is
 *     polling again → guarding (the poll route does this too; this catches a vault funded meanwhile);
 *  3. prompt_drift_hash on a funded|guarding|dormant vault (the proxy saw a different system prompt
 *     than the self-check pinned) → closeCastle(id, "orders_changed"): pot back to the owner.
 */

const C = schema.castles;
const LIVE: VaultState[] = ["funded", "guarding", "dormant"];

const g = globalThis as unknown as { __siegeGuardCloseBackoff?: Map<string, number> };
const closeBackoff = (g.__siegeGuardCloseBackoff ??= new Map<string, number>());

export type GuardTickResult = { expired: number; dormant: string[]; guarding: string[]; closed: string[] };

export async function guardTick(now = Date.now()): Promise<GuardTickResult> {
  const out: GuardTickResult = { expired: expireStale(now), dormant: [], guarding: [], closed: [] };
  const rows = db()
    .select({ id: C.id, vaultState: C.vaultState, leaseId: C.leaseId, lastSeenAt: C.lastSeenAt, drift: C.promptDriftHash })
    .from(C)
    .where(and(eq(C.transport, "sdk"), inArray(C.vaultState, LIVE)))
    .all();
  for (const r of rows) {
    if (r.drift) {
      const due = closeBackoff.get(r.id);
      if (due && due > now) continue;
      const c = await closeCastle(r.id, "orders_changed");
      if (c.ok) {
        closeBackoff.delete(r.id);
        out.closed.push(r.id);
        log.info(`guard: ${r.id} closed (orders_changed: the harness's system prompt changed after the self-check)`);
      } else {
        closeBackoff.set(r.id, now + 30_000);
        log.fail(`guard: closing ${r.id} for orders_changed failed (${c.reason}), retrying in 30s`);
      }
      continue;
    }
    if (!r.leaseId) continue;
    const live = leaseLive(r, now);
    if (r.vaultState === "guarding" && !live) {
      const t = await transitionVault(r.id, "dormant", `harness offline (no poll for ${LEASE_TTL_MS / 1000}s)`);
      if (t.ok) out.dormant.push(r.id);
    } else if ((r.vaultState === "funded" || r.vaultState === "dormant") && live) {
      const t = await transitionVault(r.id, "guarding", "harness connected");
      if (t.ok) out.guarding.push(r.id);
    }
  }
  return out;
}

