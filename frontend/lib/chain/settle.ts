import { eq } from "drizzle-orm";
import { env } from "@/lib/config/env";
import { schema, type DB } from "@/lib/db";
import type { FeeSplit, SiegeEvent, VaultCloseReason, VaultState, Verification } from "@/lib/types";
import { accountEvmAddress } from "./mirror";
import { configuredChainId } from "./evm";
import { releaseTypedData, STUB_VAULT_ADDRESS, type ReleaseTypedData } from "./releaseSig";

/**
 * Shared, mode-independent rules for settling a siege on chain. Both the stub and the testnet
 * ChainPort use these, so stub mode refuses exactly what the contract would refuse.
 * Nothing here writes to the DB.
 */

export type SiegeRow = typeof schema.sieges.$inferSelect;
export type CastleRow = typeof schema.castles.$inferSelect;
export type ReceiptRow = typeof schema.paymentReceipts.$inferSelect;
export type SettleRows = { siege: SiegeRow; castle: CastleRow; receipt: ReceiptRow | null };

export type Refusal = { ok: false; reason: string };

/** Same bounds as SiegeVault.createVault's `tool`: 1..64 bytes. */
export const validProtectedTool = (tool: unknown): tool is string =>
  typeof tool === "string" && Buffer.byteLength(tool, "utf8") >= 1 && Buffer.byteLength(tool, "utf8") <= 64;

/** Vault states in which the castle's on-chain vault exists and is Open (funded and not broken/closed). */
export const VAULT_OPEN_STATES: ReadonlySet<VaultState> = new Set<VaultState>(["funded", "guarding", "dormant"]);

/** Void reason written on the sieges a closed vault strands (their fees are refunded). */
export const closeVoidReason = (reason: VaultCloseReason) => `castle_closed_${reason}`;

export function loadSettle(d: DB, siegeId: string): ({ ok: true } & SettleRows) | Refusal {
  const siege = d.select().from(schema.sieges).where(eq(schema.sieges.id, siegeId)).get();
  if (!siege) return { ok: false, reason: "siege_not_found" };
  const castle = d.select().from(schema.castles).where(eq(schema.castles.id, siege.castleId)).get();
  if (!castle) return { ok: false, reason: "castle_not_found" };
  const receipt = siege.receiptId
    ? (d.select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.id, siege.receiptId)).get() ?? null)
    : null;
  return { ok: true, siege, castle, receipt };
}

export const isFreeSiege = (r: SettleRows) => r.siege.free || r.receipt?.free === true;

/**
 * On-chain vault is still Open. The worker flips castles.status to "broken" in the same transaction
 * that records a release, and `seed --rearm` sets it back to "open" with a NEW vault, so the castle
 * status is the source of truth (a sibling's old release must not block a re-armed vault).
 */
function vaultOpen(r: SettleRows): boolean {
  return r.castle.status === "open";
}

function paidRefusal(r: SettleRows): string | null {
  if (!r.receipt) return "no_receipt";
  // A stub "payment" (e.g. a stub-mode DB flipped to testnet) moved no real money: never forward a real fee for it.
  if (r.receipt.stub && env().CHAIN_MODE !== "stub") return "stub_receipt";
  if (r.receipt.amountTinybar < r.castle.feeTinybar) return "underpaid";
  return null;
}

/** Why recordAttempt must refuse, or null. Mirrors SiegeVault.recordAttempt. */
export function attemptRefusal(d: DB, r: SettleRows, now = Date.now()): string | null {
  if (isFreeSiege(r)) return "free_siege";
  if (r.siege.voidReason) return "void";
  if (r.siege.status !== "held" && r.siege.status !== "banished") return "bad_status";
  if (r.siege.attemptTx) return "already_recorded";
  if (r.siege.releaseTx) return "already_released";
  const paid = paidRefusal(r);
  if (paid) return paid;
  if (!vaultOpen(r)) return "vault_not_open";
  if (r.castle.deadline <= now) return "expired";
  return null;
}

/** Why a release (or preparing one) must refuse, or null. Mirrors SiegeVault.release. */
export function releaseRefusal(d: DB, r: SettleRows): string | null {
  if (isFreeSiege(r)) return "free_siege";
  if (r.siege.voidReason) return "void";
  if (r.siege.status !== "broken") return "bad_status";
  if (!r.siege.transcriptHash) return "no_transcript";
  if (r.siege.releaseTx) return "already_released";
  if (r.siege.attemptTx) return "already_recorded";
  const paid = paidRefusal(r);
  if (paid) return paid;
  if (!vaultOpen(r)) return "vault_not_open";
  return null;
}

/** Checks the verifier's verdict matches this siege before anything is sent. */
export function verdictRefusal(r: SettleRows, v: Verification): string | null {
  if (v.siegeId !== r.siege.id) return "siege_mismatch";
  if (!v.ok) return "not_verified";
  if ((v.transcriptHash ?? "").toLowerCase() !== (r.siege.transcriptHash ?? "").toLowerCase()) return "transcript_mismatch";
  return null;
}

/** Fee split exactly like the contract: c = fee*cBps/10000, a = fee*aBps/10000, p = fee - c - a. */
export function computeSplit(fee: bigint): { castellan: bigint; pot: bigint; arena: bigint } {
  const e = env();
  const castellan = (fee * BigInt(e.FEE_SPLIT_CASTELLAN_BPS)) / BigInt(10_000);
  const arena = (fee * BigInt(e.FEE_SPLIT_ARENA_BPS)) / BigInt(10_000);
  return { castellan, arena, pot: fee - castellan - arena };
}

export const splitToAmounts = (s: { castellan: bigint; pot: bigint; arena: bigint }): FeeSplit => ({
  castellan: s.castellan.toString(),
  pot: s.pot.toString(),
  arena: s.arena.toString(),
});

/** The vault address the Release signature is bound to (stand-in address in stub mode). */
export function releaseVaultAddress(): `0x${string}` {
  const e = env();
  if (e.VAULT_ADDRESS) return e.VAULT_ADDRESS as `0x${string}`;
  if (e.CHAIN_MODE === "stub") return STUB_VAULT_ADDRESS;
  throw new Error("Missing env VAULT_ADDRESS (required when CHAIN_MODE=testnet)");
}

/** Vault id used on chain. Stub mode tolerates castles without a vault (id 0). */
export function chainVaultId(r: SettleRows): number | null {
  if (r.castle.vaultId != null) return r.castle.vaultId;
  return env().CHAIN_MODE === "stub" ? 0 : null;
}

/**
 * The chain id the Release is signed for. Stub: the configured id (296 by default). Testnet: the id
 * the RPC serves, checked against the configured one (a mismatch would revert BadSignature forever).
 */
async function releaseChainId(): Promise<number> {
  if (env().CHAIN_MODE === "stub") return configuredChainId();
  const { rpcChainId } = await import("./evm");
  return rpcChainId();
}

const reasonOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Build the EIP-712 Release for a broken siege. The raider address is resolved STRICTLY (a mirror
 * failure is a retryable "mirror_unavailable", never a long-zero fallback), so the address that is
 * signed and the address that is sent come from the same lookup.
 */
export async function buildRelease(r: SettleRows): Promise<
  { ok: true; typedData: ReleaseTypedData; operator: `0x${string}`; vaultId: number } | Refusal
> {
  const vaultId = chainVaultId(r);
  if (vaultId == null) return { ok: false, reason: "no_vault" };
  if (!r.siege.transcriptHash) return { ok: false, reason: "no_transcript" };
  let operator: `0x${string}`;
  let chainId: number;
  try {
    operator = await accountEvmAddress(r.siege.raider, { strict: true });
  } catch {
    return { ok: false, reason: "mirror_unavailable" };
  }
  try {
    chainId = await releaseChainId();
  } catch (err) {
    const msg = reasonOf(err);
    return { ok: false, reason: msg.startsWith("chain_id_mismatch") ? "chain_id_mismatch" : `rpc_error: ${msg}` };
  }
  const typedData = releaseTypedData({
    chainId,
    vault: releaseVaultAddress(),
    vaultId: BigInt(vaultId),
    operator,
    transcriptHash: r.siege.transcriptHash as `0x${string}`,
    opId: r.siege.id,
  });
  return { ok: true, typedData, operator, vaultId };
}

// ─── HCS audit message ──────────────────────────────────────────────────────

export const AUDIT_MAX_BYTES = 1000;

/** Resolve the castle an event belongs to (event.castleId, else via its siege). */
export function auditCastle(d: Pick<DB, "select">, event: SiegeEvent): CastleRow | null {
  let castleId = event.castleId;
  if (!castleId && event.siegeId) {
    castleId = d.select({ c: schema.sieges.castleId }).from(schema.sieges).where(eq(schema.sieges.id, event.siegeId)).get()?.c;
  }
  if (!castleId) return null;
  return d.select().from(schema.castles).where(eq(schema.castles.id, castleId)).get() ?? null;
}

const str = (v: unknown, max = 120): string | undefined =>
  typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined;

/**
 * HCS message types (plan A4, frozen — Lane C's replay / mirror readers filter on these exact strings):
 *   vault.state  vault lifecycle transition {from,to,reason}
 *   siege.start / siege.message / siege.decision / siege.end (end carries `result` and the transcript hash)
 *   siege.attempt  fee split recorded on chain (held/banished)
 *   vault.release  pot paid out on chain (tx id)
 *   agent.approval raider-agent approval requested / decided
 */
export const AUDIT_TYPES = {
  vault_state: "vault.state",
  start: "siege.start",
  message: "siege.message",
  decision: "siege.decision",
  end: "siege.end",
  attempt: "siege.attempt",
  release: "vault.release",
  approval: "agent.approval",
} as const satisfies Record<SiegeEvent["type"], string>;

export function auditType(event: SiegeEvent): string {
  return AUDIT_TYPES[event.type] ?? event.type;
}

/** A non-negative integer amount in the smallest unit (tinybar for HBAR), as a decimal string. */
const units = (v: unknown): string | undefined => {
  if (typeof v === "bigint") return v >= BigInt(0) ? v.toString() : undefined;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : undefined;
  return typeof v === "string" && /^\d{1,30}$/.test(v) ? v : undefined;
};

/** {castellan, pot, arena} cuts of a fee, each in the smallest unit, or undefined. */
function cutsOf(v: unknown): { castellan: string; pot: string; arena: string } | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const castellan = units(o.castellan);
  const pot = units(o.pot);
  const arena = units(o.arena);
  return castellan && pot && arena ? { castellan, pot, arena } : undefined;
}

const APPROVAL_KINDS = new Set(["requested", "approved", "denied"]);

/**
 * Compact audit JSON (<= 1000 bytes). Only ids, hashes and amounts leave the server; message text,
 * orders and the agent's reasoning never do. Amounts are strings in the asset's smallest unit (tinybar).
 *   siege events:   {v:1,type,siegeId,castleId,turn?,transport?,result?,hash?,requestId?,txId?,at}
 *                   (type = auditType(event); transport + requestId = which guardian transport answered and
 *                   the proxy request id; result = held | banished | broken on siege.end, plan A4)
 *   siege.attempt:  + amount (the fee forwarded) and split {castellan,pot,arena}, when the payload has the split
 *   vault.release:  + amount (pot + fee paid to the raider), when the payload has it
 *   agent.approval: {v:1,type:"agent.approval",siegeId,castleId,kind:requested|approved|denied,approvalId,
 *                    agentId,reason (cap hit),amount (extra allowance asked),txId? (the top-up),at}
 *   vault_state:    {v:1,type:"vault.state",castleId,from,to,reason,at}
 */
export function auditMessage(event: SiegeEvent, castleId: string): string {
  const p = (event.payload ?? {}) as Record<string, unknown>;
  if (event.type === "vault_state") {
    const msg: Record<string, unknown> = {
      v: 1,
      type: "vault.state",
      castleId: castleId.slice(0, 80),
      from: str(p.from, 20),
      to: str(p.to, 20),
      reason: str(p.reason, 200) ?? "",
      at: event.at,
    };
    let out = JSON.stringify(msg);
    // Reasons are free text (multi-byte characters): shrink until it fits.
    while (Buffer.byteLength(out, "utf8") > AUDIT_MAX_BYTES && typeof msg.reason === "string" && msg.reason.length > 0) {
      msg.reason = msg.reason.slice(0, Math.floor(msg.reason.length / 2));
      out = JSON.stringify(msg);
    }
    return out;
  }
  const tx = p.tx as { txId?: unknown } | undefined;
  const transport = event.transport ?? p.transport;
  const result = str(p.result, 20) ?? (event.type === "end" ? str(p.status, 20) : undefined);
  const msg: Record<string, unknown> = {
    v: 1,
    type: auditType(event),
    siegeId: str(event.siegeId, 80) ?? "",
    castleId: castleId.slice(0, 80),
    turn: typeof event.turn === "number" ? event.turn : undefined,
    transport: transport === "hosted" || transport === "sdk" ? transport : undefined,
    result,
    hash: str(p.transcriptHash) ?? str(p.hash),
    requestId: str(event.requestId) ?? str(p.requestId),
    txId: str(p.txId) ?? str(tx?.txId),
    at: event.at,
  };
  if (event.type === "approval") {
    const kind = str(p.kind, 20);
    Object.assign(msg, {
      kind: kind && APPROVAL_KINDS.has(kind) ? kind : undefined,
      approvalId: str(p.approvalId, 80),
      agentId: str(p.agentId, 80),
      reason: str(p.reason, 40),
      amount: units(p.amount),
    });
  } else if (event.type === "attempt") {
    const split = cutsOf(p.split);
    const fee = split ? (BigInt(split.castellan) + BigInt(split.pot) + BigInt(split.arena)).toString() : undefined;
    Object.assign(msg, { amount: units(p.amount) ?? fee, split });
  } else if (event.type === "release") {
    msg.amount = units(p.amount);
  }
  let out = JSON.stringify(msg);
  for (const k of ["requestId", "txId", "hash"]) {
    if (Buffer.byteLength(out, "utf8") <= AUDIT_MAX_BYTES) break;
    delete msg[k];
    out = JSON.stringify(msg);
  }
  return out;
}
