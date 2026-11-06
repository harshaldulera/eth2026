import { eq } from "drizzle-orm";
import { arkiv } from "@/lib/arkiv";
import { getCastle } from "@/lib/castles";
import { chain } from "@/lib/chain";
import { db, schema } from "@/lib/db";
import { emit } from "@/lib/events/bus";
import { voidInFlightSieges } from "@/lib/pay/refunds";
import type { CastleStatus, TransportKind, VaultState, VaultStateChange, VaultStatePort } from "@/lib/types";
import { nowIso } from "@/lib/util/ids";

/**
 * lib/vault/state — the one place a vault changes state.
 *
 *   hosted: created → verified → funded → guarding
 *   sdk:    created → connected → verified (smoke siege passed) → funded → guarding ⇄ dormant
 *   end:    broken (paid out) | closed (expired / orders_changed / owner_closed); any non-terminal state may close
 *
 * Every transition, in order: the castles row (vaultState, vaultStateReason, and castles.status kept in
 * sync: broken -> "broken", closed -> "closed", everything else -> "open"), money side effects (dormant:
 * every in-flight siege is voided and its paid fee queued for refund; the vault stays funded on chain),
 * a "vault_state" bus event (siegeId "", payload VaultStateChange), then — best effort, never failing the
 * transition — the HCS audit ("vault.state" {from,to,reason}) and the Arkiv castle entity.
 *
 * Lane A drives funded (lib/vault/fund), broken (worker release) and closed (lib/vault/close);
 * Lane B drives connected / verified / guarding / dormant. Only "guarding" castles take sieges.
 *
 * transitionVault is RAW (no chain side effects): only lib/vault/fund, lib/vault/close, the worker and
 * seed scripts call it. Every other caller uses the VaultStatePort `vaultState` (lib/vault/port.ts),
 * which refuses funded / broken and routes closed through closeCastle.
 */

const C = schema.castles;

export const VAULT_STATES: readonly VaultState[] = ["created", "connected", "verified", "funded", "guarding", "dormant", "broken", "closed"];
export const TERMINAL_STATES: ReadonlySet<VaultState> = new Set<VaultState>(["broken", "closed"]);

/** Legal next states. Transport-specific edges are checked in isLegalTransition. */
const NEXT: Record<VaultState, readonly VaultState[]> = {
  created: ["connected", "verified", "closed"],
  connected: ["verified", "closed"],
  verified: ["funded", "closed"],
  funded: ["guarding", "closed"],
  guarding: ["dormant", "broken", "closed"],
  // A siege that ended broken just before the harness dropped can still be paid out.
  dormant: ["guarding", "broken", "closed"],
  broken: [],
  closed: [],
};

/** Only an SDK harness connects, heartbeats and goes dormant; a hosted guardian is verified straight from created. */
export function isLegalTransition(from: VaultState, to: VaultState, transport: TransportKind): boolean {
  if (!NEXT[from]?.includes(to)) return false;
  if ((to === "connected" || to === "dormant" || from === "dormant") && transport !== "sdk") return false;
  if (from === "created" && to === "verified" && transport !== "hosted") return false;
  return true;
}

/** castles.status for a vault state (the legacy column the money rules still read). */
export function castleStatusFor(state: VaultState): CastleStatus {
  return state === "broken" ? "broken" : state === "closed" ? "closed" : "open";
}

/** Void reason on sieges stranded by a guardian that stopped answering. */
export const DORMANT_VOID_REASON = "guardian_dormant";

export type TransitionResult = Awaited<ReturnType<VaultStatePort["transition"]>>;

export type TransitionOpts = {
  /** Seed only: skip the legality check (re-arming a broken/closed castle with a new vault). */
  force?: boolean;
  /** Wait for the HCS audit and the Arkiv write (scripts that exit right after). Default: fire and forget. */
  awaitSideEffects?: boolean;
};

const warn = (what: string) => (e: unknown) => console.warn(`[vault] ${what} failed:`, e instanceof Error ? e.message : e);

export async function transitionVault(castleId: string, to: VaultState, reason: string, opts: TransitionOpts = {}): Promise<TransitionResult> {
  if (!VAULT_STATES.includes(to)) return { ok: false, reason: "illegal_transition" };
  const at = nowIso();
  const why = String(reason ?? "").slice(0, 500);
  const res = db().transaction((tx): TransitionResult => {
    const row = tx.select({ vaultState: C.vaultState, transport: C.transport }).from(C).where(eq(C.id, castleId)).get();
    if (!row) return { ok: false, reason: "not_found" };
    const from = row.vaultState;
    if (!opts.force && !isLegalTransition(from, to, row.transport)) return { ok: false, reason: "illegal_transition" };
    tx.update(C).set({ vaultState: to, vaultStateReason: why, status: castleStatusFor(to) }).where(eq(C.id, castleId)).run();
    return { ok: true, change: { castleId, from, to, reason: why, at } };
  });
  if (!res.ok) return res;

  // Money first: nobody may keep playing (or paying) against a guardian that is gone.
  if (to === "dormant") voidInFlightSieges(castleId, DORMANT_VOID_REASON);
  else if (to === "closed") voidInFlightSieges(castleId, "castle_closed");

  const change: VaultStateChange = res.change;
  emit({ siegeId: "", castleId, type: "vault_state", payload: { ...change }, at });

  const audit = chain
    .audit({ siegeId: "", castleId, type: "vault_state", payload: { from: change.from, to: change.to, reason: change.reason }, at })
    .then((r) => {
      if (!r.ok) console.warn(`[vault] audit vault.state ${castleId}: ${r.reason}`);
    })
    .catch(warn("audit"));
  const castle = getCastle(castleId);
  const entity = castle ? arkiv.writeCastle(castle).then(() => undefined, warn("arkiv.writeCastle")) : Promise.resolve();
  if (opts.awaitSideEffects) await Promise.all([audit, entity]);
  return res;
}

/** Current vault state, or null for an unknown castle. Synchronous (one indexed read). */
export function vaultStateOf(castleId: string): VaultState | null {
  return db().select({ s: C.vaultState }).from(C).where(eq(C.id, castleId)).get()?.s ?? null;
}

/** Only guarding castles take sieges and are listed on the board. */
export function isGuarding(castleId: string): boolean {
  return vaultStateOf(castleId) === "guarding";
}

