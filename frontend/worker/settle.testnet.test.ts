/**
 * Worker settlement against the REAL testnet ChainPort (lib/chain/testnet.ts) with the SiegeVault
 * transport mocked (lib/chain/vault): the reconciliation paths for writes that landed but whose
 * result never reached the DB, and the raider-address / signature consistency for releases.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
process.env.SIEGE_FAST = "1";
import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { MUST_NOT_BREAK, WOODEN_BREAK } from "@/lib/fixtures/raids";
import { eventsSince } from "@/lib/events/bus";
import { persistReceipt } from "@/lib/pay";
import { siege } from "@/lib/siege";
import type { PaidReceipt } from "@/lib/types";

const VAULT = "0x00000000000000000000000000000000005e1e01";
const VERIFIER_KEY = "0x2000000000000000000000000000000000000000000000000000000000000002";
const ALIAS = "0x1111111111111111111111111111111111111111";
const LONG_ZERO = "0x00000000000000000000000000000000000004d2";
const HASH1 = `0x${"a1".repeat(32)}` as const;
const HASH2 = `0x${"b2".repeat(32)}` as const;

// ── mocks ────────────────────────────────────────────────────────────────────
const vaultMock = vi.hoisted(() => ({
  recordAttempt: vi.fn(),
  release: vi.fn(),
  writeOutcome: vi.fn(),
  opConsumed: vi.fn(),
  findOpLog: vi.fn(),
}));
vi.mock("@/lib/chain/vault", async (orig) => ({ ...(await orig<typeof import("@/lib/chain/vault")>()), ...vaultMock }));

const mirrorMock = vi.hoisted(() => ({ accountEvmAddress: vi.fn() }));
vi.mock("@/lib/chain/mirror", async (orig) => ({ ...(await orig<typeof import("@/lib/chain/mirror")>()), ...mirrorMock }));

vi.mock("@/lib/chain/evm", async (orig) => ({ ...(await orig<typeof import("@/lib/chain/evm")>()), rpcChainId: async () => 296 }));

const { VaultError } = await import("@/lib/chain/vault");
const { settleTick } = await import("./settle");
const { createTestnetChain } = await import("@/lib/chain/testnet");
const { releaseTypedData } = await import("@/lib/chain/releaseSig");

// ── helpers ──────────────────────────────────────────────────────────────────
const backoff = () => (globalThis as unknown as { __siegeSettleBackoff?: Map<string, number> }).__siegeSettleBackoff?.clear();

let n = 0;
function paidReceipt(payer = "0.0.1234", amount = "100000000"): Omit<PaidReceipt, "siegeId"> {
  n++;
  return {
    free: false,
    txId: `0.0.9185802@1762400000.00000000${n}`,
    payer,
    amount,
    asset: "0.0.0",
    network: "hedera:testnet",
    hashscanUrl: "https://hashscan.io/testnet/transaction/x",
  };
}

async function playSiege(castleId: string, texts: readonly string[], payer?: string) {
  const fee = db().select({ f: schema.castles.feeTinybar }).from(schema.castles).where(eq(schema.castles.id, castleId)).get()!.f;
  const receipt = paidReceipt(payer, String(fee));
  const receiptId = persistReceipt(receipt);
  const s = await siege.start({ castleId, raider: receipt.payer, receipt, receiptId });
  for (const t of texts) {
    const r = await siege.message(s.id, t);
    if (!r.ok || r.siege.status !== "in_progress") break;
  }
  return s.id;
}

const siegeRow = (id: string) => db().select().from(schema.sieges).where(eq(schema.sieges.id, id)).get()!;
const castleRow = (id: string) => db().select().from(schema.castles).where(eq(schema.castles.id, id)).get()!;

const attemptResult = (txHash: `0x${string}`) => ({
  txHash,
  ownerCut: BigInt(80_000_000),
  potCut: BigInt(15_000_000),
  arenaCut: BigInt(5_000_000),
  newPot: BigInt(2_015_000_000),
  streak: 1,
});

beforeEach(() => {
  process.env.CHAIN_MODE = "testnet";
  process.env.OWNER_SECRET = "test-owner-secret-0123";
  process.env.VAULT_ADDRESS = VAULT;
  process.env.VERIFIER_KEY = VERIFIER_KEY;
  freshFixtureDb();
  resetEnv();
  db().update(schema.castles).set({ vaultId: 7, vaultAddress: VAULT.toLowerCase() }).run();
  for (const f of Object.values(vaultMock)) f.mockReset();
  mirrorMock.accountEvmAddress.mockReset().mockResolvedValue(ALIAS);
  vaultMock.writeOutcome.mockResolvedValue({ status: "not_found" });
  vaultMock.opConsumed.mockResolvedValue(false);
  vaultMock.findOpLog.mockResolvedValue(null);
  backoff();
});

afterAll(() => {
  for (const k of ["CHAIN_MODE", "OWNER_SECRET", "VAULT_ADDRESS", "VERIFIER_KEY"]) delete process.env[k];
  resetEnv();
});

describe("a chain write that landed is reconciled, never abandoned", () => {
  it("held: receipt timeout after broadcast -> pending tx recorded -> next pass applies it from the receipt", async () => {
    const id = await playSiege("castle_granite_hold", MUST_NOT_BREAK);
    expect(siegeRow(id).status).toBe("held");
    vaultMock.recordAttempt.mockImplementationOnce(async (_p: unknown, onSent: (h: string) => void) => {
      await onSent(HASH1);
      throw new VaultError("receipt_timeout", "Timed out while waiting for transaction", HASH1);
    });

    await settleTick();
    let row = siegeRow(id);
    expect(row).toMatchObject({ pendingTx: HASH1, attemptTx: null, chainError: "receipt_timeout", chainAttempts: 1, settledAt: null });

    vaultMock.writeOutcome.mockResolvedValue({ status: "success", result: attemptResult(HASH1) });
    backoff();
    await settleTick();
    row = siegeRow(id);
    expect(row).toMatchObject({ attemptTx: HASH1, pendingTx: null, chainError: null });
    expect(row.settledAt).toBeTruthy();
    expect(vaultMock.recordAttempt).toHaveBeenCalledTimes(1); // never re-sent
    expect(castleRow("castle_granite_hold").potTinybar).toBe(2_015_000_000);
    expect(eventsSince(0, { siegeId: id }).some((e) => e.type === "attempt")).toBe(true);
  });

  it("held: Replay with no known hash -> opConsumed + AttemptRecorded log -> applied as success", async () => {
    const id = await playSiege("castle_granite_hold", MUST_NOT_BREAK);
    vaultMock.recordAttempt.mockRejectedValueOnce(new VaultError("Replay", "SiegeVault.recordAttempt reverted: Replay"));
    vaultMock.opConsumed.mockResolvedValue(true);
    vaultMock.findOpLog.mockResolvedValue(attemptResult(HASH2));
    await settleTick();
    const row = siegeRow(id);
    expect(row).toMatchObject({ attemptTx: HASH2, chainError: null });
    expect(vaultMock.findOpLog).toHaveBeenCalledWith("AttemptRecorded", BigInt(7), expect.any(String), expect.any(Number));
  });

  it("consumed on chain but the mirror has no log yet -> retryable, not given up", async () => {
    const id = await playSiege("castle_granite_hold", MUST_NOT_BREAK);
    vaultMock.recordAttempt.mockRejectedValueOnce(new VaultError("Replay", "Replay"));
    vaultMock.opConsumed.mockResolvedValue(true);
    await settleTick();
    expect(siegeRow(id)).toMatchObject({ chainError: "reconcile_pending", chainAttempts: 1, settledAt: null });
  });

  it("broken: BadStatus because our own release already landed -> Broken log -> castle broken, raider paid", async () => {
    const id = await playSiege("castle_splinter_gate", WOODEN_BREAK);
    expect(siegeRow(id).status).toBe("broken");
    vaultMock.release.mockRejectedValueOnce(new VaultError("BadStatus", "SiegeVault.release reverted: BadStatus"));
    vaultMock.opConsumed.mockResolvedValue(true);
    vaultMock.findOpLog.mockResolvedValue({ txHash: HASH2, amount: BigInt(550_000_000) });
    await settleTick();
    expect(siegeRow(id)).toMatchObject({ releaseTx: HASH2, releaseAmountTinybar: 550_000_000, chainError: null });
    expect(castleRow("castle_splinter_gate")).toMatchObject({ status: "broken", potTinybar: 0 });
  });

  it("BadStatus with the siege NOT consumed (someone else emptied the vault) -> void + refund, not a silent give-up", async () => {
    const id = await playSiege("castle_granite_hold", MUST_NOT_BREAK);
    vaultMock.recordAttempt.mockRejectedValueOnce(new VaultError("BadStatus", "BadStatus"));
    await settleTick();
    const row = siegeRow(id);
    expect(row.voidReason).toBe("vault_not_open");
    const rc = db().select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.id, row.receiptId!)).get()!;
    // testnet refund needs the operator: here it fails cleanly and is left for a human, never retried
    expect(["refund_due", "refunding", "refund_failed"]).toContain(rc.state);
  });

  it("a pending tx that landed wins over a later DB-level refusal (sibling release recorded meanwhile)", async () => {
    const id = await playSiege("castle_granite_hold", MUST_NOT_BREAK);
    db().update(schema.sieges).set({ pendingTx: HASH1 }).where(eq(schema.sieges.id, id)).run();
    db().update(schema.castles).set({ status: "broken" }).where(eq(schema.castles.id, "castle_granite_hold")).run();
    vaultMock.writeOutcome.mockResolvedValue({ status: "success", result: attemptResult(HASH1) });
    await settleTick();
    expect(siegeRow(id)).toMatchObject({ attemptTx: HASH1, voidReason: null });
  });
});

describe("a write that lost the race against closeVault is refunded, never stuck", () => {
  const receiptState = (siegeId: string) =>
    db().select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.id, siegeRow(siegeId).receiptId!)).get()!.state;
  const closeCastleInDb = () =>
    db().update(schema.castles).set({ status: "closed", vaultState: "closed", potTinybar: 0 }).where(eq(schema.castles.id, "castle_granite_hold")).run();

  it("recordAttempt sent, then reverted because the close mined first: pending tx cleared, next pass voids + refunds", async () => {
    const id = await playSiege("castle_granite_hold", MUST_NOT_BREAK);
    const streak = castleRow("castle_granite_hold").streak;
    vaultMock.recordAttempt.mockImplementationOnce(async (_p: unknown, onSent: (h: string) => void) => {
      await onSent(HASH1);
      closeCastleInDb(); // the close (which skipped this siege: pending_tx set) mines first
      throw new VaultError("reverted", "SiegeVault.recordAttempt reverted on chain", HASH1);
    });
    vaultMock.writeOutcome.mockResolvedValue({ status: "reverted" });
    await settleTick();
    expect(siegeRow(id)).toMatchObject({ pendingTx: null, attemptTx: null, voidReason: null, chainError: "reverted", chainAttempts: 1 });
    backoff();
    await settleTick();
    expect(siegeRow(id)).toMatchObject({ voidReason: "vault_not_open", attemptTx: null });
    expect(["refund_due", "refunding", "refund_failed"]).toContain(receiptState(id));
    expect(castleRow("castle_granite_hold")).toMatchObject({ potTinybar: 0, streak });
  });

  it("a pending tx a crashed pass left behind, proven reverted: cleared, then refused and refunded in the same pass", async () => {
    const id = await playSiege("castle_granite_hold", MUST_NOT_BREAK);
    db().update(schema.sieges).set({ pendingTx: HASH2 }).where(eq(schema.sieges.id, id)).run();
    closeCastleInDb();
    vaultMock.writeOutcome.mockResolvedValue({ status: "reverted" });
    await settleTick();
    expect(siegeRow(id)).toMatchObject({ pendingTx: null, voidReason: "vault_not_open" });
    expect(["refund_due", "refunding", "refund_failed"]).toContain(receiptState(id));
    expect(vaultMock.recordAttempt).not.toHaveBeenCalled();
  });

  it("reverted but the siege id IS consumed on chain (another tx landed it): pending tx kept, nothing voided", async () => {
    const id = await playSiege("castle_granite_hold", MUST_NOT_BREAK);
    db().update(schema.sieges).set({ pendingTx: HASH2 }).where(eq(schema.sieges.id, id)).run();
    closeCastleInDb();
    vaultMock.writeOutcome.mockResolvedValue({ status: "reverted" });
    vaultMock.opConsumed.mockResolvedValue(true);
    await settleTick();
    expect(siegeRow(id)).toMatchObject({ pendingTx: HASH2, voidReason: null });
    expect(receiptState(id)).toBe("settled");
  });
});

describe("raider address: resolved once, signature re-checked before sending", () => {
  it("a mirror failure while preparing is retryable; the signed raider == the sent raider", async () => {
    const id = await playSiege("castle_splinter_gate", WOODEN_BREAK, "0.0.1234");
    mirrorMock.accountEvmAddress.mockImplementation(async (_id: string, o?: { strict?: boolean }) => {
      if (o?.strict && mirrorMock.accountEvmAddress.mock.calls.length === 1) throw new Error("mirror_unavailable: fetch failed");
      return ALIAS;
    });
    vaultMock.release.mockImplementation(async (p: { operator: string }) => ({ txHash: HASH1, amount: BigInt(550_000_000), operator: p.operator }));

    await settleTick();
    expect(siegeRow(id)).toMatchObject({ chainError: "mirror_unavailable", chainAttempts: 1, releaseTx: null });
    backoff();
    await settleTick();
    expect(siegeRow(id)).toMatchObject({ releaseTx: HASH1 });
    expect(vaultMock.release).toHaveBeenCalledTimes(1);
    expect(vaultMock.release.mock.calls[0][0].operator).toBe(ALIAS);
  });

  it("a signature over a different raider is refused as stale_signature (retryable) before anything is sent", async () => {
    const id = await playSiege("castle_splinter_gate", WOODEN_BREAK, "0.0.1234");
    const row = siegeRow(id);
    const signer = privateKeyToAccount(VERIFIER_KEY);
    const td = releaseTypedData({ chainId: 296, vault: VAULT, vaultId: BigInt(7), operator: LONG_ZERO, transcriptHash: row.transcriptHash as `0x${string}`, opId: id });
    const signature = await signer.signTypedData(td);
    const r = await createTestnetChain().release(id, { siegeId: id, transcriptHash: row.transcriptHash as `0x${string}`, requestId: "x", ok: true, signature });
    expect(r).toEqual({ ok: false, reason: "stale_signature" });
    expect(vaultMock.release).not.toHaveBeenCalled();
  });

  it("stub receipts never get a real fee forwarded in testnet mode", async () => {
    const receipt = { ...paidReceipt(), stub: true, txId: "stub:x402@1" };
    const receiptId = persistReceipt(receipt);
    const s = await siege.start({ castleId: "castle_granite_hold", raider: receipt.payer, receipt, receiptId });
    for (const t of MUST_NOT_BREAK) await siege.message(s.id, t);
    await settleTick();
    expect(siegeRow(s.id)).toMatchObject({ chainError: "stub_receipt", chainAttempts: 5 });
    expect(vaultMock.recordAttempt).not.toHaveBeenCalled();
  });
});
