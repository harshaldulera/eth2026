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
  siegeConsumed: vi.fn(),
  findSiegeLog: vi.fn(),
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
  castellanCut: BigInt(80_000_000),
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
  vaultMock.siegeConsumed.mockResolvedValue(false);
  vaultMock.findSiegeLog.mockResolvedValue(null);
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

  it("held: Replay with no known hash -> siegeConsumed + AttemptRecorded log -> applied as success", async () => {
    const id = await playSiege("castle_granite_hold", MUST_NOT_BREAK);
    vaultMock.recordAttempt.mockRejectedValueOnce(new VaultError("Replay", "SiegeVault.recordAttempt reverted: Replay"));
    vaultMock.siegeConsumed.mockResolvedValue(true);
    vaultMock.findSiegeLog.mockResolvedValue(attemptResult(HASH2));
    await settleTick();
    const row = siegeRow(id);
    expect(row).toMatchObject({ attemptTx: HASH2, chainError: null });
    expect(vaultMock.findSiegeLog).toHaveBeenCalledWith("AttemptRecorded", BigInt(7), expect.any(String), expect.any(Number));
  });

  it("consumed on chain but the mirror has no log yet -> retryable, not given up", async () => {
    const id = await playSiege("castle_granite_hold", MUST_NOT_BREAK);
    vaultMock.recordAttempt.mockRejectedValueOnce(new VaultError("Replay", "Replay"));
    vaultMock.siegeConsumed.mockResolvedValue(true);
    await settleTick();
    expect(siegeRow(id)).toMatchObject({ chainError: "reconcile_pending", chainAttempts: 1, settledAt: null });
  });

  it("broken: BadStatus because our own release already landed -> Broken log -> castle broken, raider paid", async () => {
    const id = await playSiege("castle_splinter_gate", WOODEN_BREAK);
    expect(siegeRow(id).status).toBe("broken");
    vaultMock.release.mockRejectedValueOnce(new VaultError("BadStatus", "SiegeVault.release reverted: BadStatus"));
    vaultMock.siegeConsumed.mockResolvedValue(true);
    vaultMock.findSiegeLog.mockResolvedValue({ txHash: HASH2, amount: BigInt(550_000_000) });
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

describe("raider address: resolved once, signature re-checked before sending", () => {
  it("a mirror failure while preparing is retryable; the signed raider == the sent raider", async () => {
    const id = await playSiege("castle_splinter_gate", WOODEN_BREAK, "0.0.1234");
    mirrorMock.accountEvmAddress.mockImplementation(async (_id: string, o?: { strict?: boolean }) => {
      if (o?.strict && mirrorMock.accountEvmAddress.mock.calls.length === 1) throw new Error("mirror_unavailable: fetch failed");
      return ALIAS;
    });
    vaultMock.release.mockImplementation(async (p: { raider: string }) => ({ txHash: HASH1, amount: BigInt(550_000_000), raider: p.raider }));

    await settleTick();
    expect(siegeRow(id)).toMatchObject({ chainError: "mirror_unavailable", chainAttempts: 1, releaseTx: null });
    backoff();
    await settleTick();
    expect(siegeRow(id)).toMatchObject({ releaseTx: HASH1 });
    expect(vaultMock.release).toHaveBeenCalledTimes(1);
    expect(vaultMock.release.mock.calls[0][0].raider).toBe(ALIAS);
  });

  it("a signature over a different raider is refused as stale_signature (retryable) before anything is sent", async () => {
    const id = await playSiege("castle_splinter_gate", WOODEN_BREAK, "0.0.1234");
    const row = siegeRow(id);
    const signer = privateKeyToAccount(VERIFIER_KEY);
    const td = releaseTypedData({ chainId: 296, vault: VAULT, vaultId: BigInt(7), raider: LONG_ZERO, transcriptHash: row.transcriptHash as `0x${string}`, siegeId: id });
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
