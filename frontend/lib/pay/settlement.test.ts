/**
 * Money safety around x402 settlement (testnet gate with a fake facilitator + mocked mirror):
 * one payload buys one siege, ambiguous settles are resolved instead of forgotten, and money that
 * moved without a siege is refunded with the agent's spend released only once it is back.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
process.env.SIEGE_FAST = "1";
import { eq } from "drizzle-orm";
import { AccountId, Hbar, Timestamp, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, ResourceInfo } from "@x402/core/types";
import { resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { __setX402ServerForTests, type GateServer } from "@/lib/pay/x402";
import { __setGatePollForTests } from "@/lib/pay/gate";
import { createAgent } from "@/lib/agents/accounts";
import { checkCaps, holdSpend, isSpendControlRefusal, reconcileReceipts, SpendControlError } from "@/lib/pay";
import { resetMirrorCache } from "@/lib/chain/mirror";
import * as startRoute from "@/app/api/siege/start/route";

const CASTLE = "castle_granite_hold"; // fee 1 ℏ
const FEE = "100000000";
const PAY_TO = "0.0.4242";

let nonce = 0;
function hederaTxBase64(): { b64: string; txId: string } {
  nonce++;
  const tx = new TransferTransaction()
    .addHbarTransfer(AccountId.fromString("0.0.1234"), Hbar.fromTinybars(`-${FEE}`))
    .addHbarTransfer(AccountId.fromString(PAY_TO), Hbar.fromTinybars(FEE))
    .setTransactionId(TransactionId.withValidStart(AccountId.fromString("0.0.9185802"), new Timestamp(1762400000, nonce)))
    .setNodeAccountIds([new AccountId(3)])
    .freeze();
  return { b64: Buffer.from(tx.toBytes()).toString("base64"), txId: `0.0.9185802@1762400000.${String(nonce).padStart(9, "0")}` };
}

const reqs: PaymentRequirements[] = [
  { scheme: "exact", network: "hedera:testnet", asset: "0.0.0", amount: FEE, payTo: PAY_TO, maxTimeoutSeconds: 180, extra: { feePayer: "0.0.9185802" } },
];

function fakeServer() {
  const server = {
    buildPaymentRequirements: vi.fn(async () => reqs),
    createPaymentRequiredResponse: vi.fn(async (accepts: PaymentRequirements[], resource: ResourceInfo, error?: string) => ({
      x402Version: 2,
      resource,
      accepts,
      ...(error ? { error } : {}),
    })),
    findMatchingRequirements: vi.fn((available: PaymentRequirements[]) => available[0]),
    verifyPayment: vi.fn(async () => ({ isValid: true, payer: "0.0.1234" })),
    settlePayment: vi.fn(),
  };
  __setX402ServerForTests(server as unknown as GateServer);
  return server;
}

function paidStart(b64: string) {
  const payload: PaymentPayload = { x402Version: 2, accepted: reqs[0], payload: { transaction: b64 } };
  return new Request("http://localhost:3000/api/siege/start", {
    method: "POST",
    headers: { "content-type": "application/json", "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) },
    body: JSON.stringify({ castleId: CASTLE }),
  });
}

/** Mirror node /transactions/{id} answers, keyed by normalized id. */
const mirror = new Map<string, unknown>();
const realFetch = globalThis.fetch;

const receipts = () => db().select().from(schema.paymentReceipts).all();
const sieges = () => db().select().from(schema.sieges).all();

beforeEach(() => {
  process.env.CHAIN_MODE = "testnet";
  process.env.OWNER_SECRET = "test-owner-secret-0123";
  process.env.X402_PAY_TO = PAY_TO;
  freshFixtureDb();
  resetEnv();
  resetMirrorCache();
  mirror.clear();
  __setGatePollForTests({ tries: 2, delayMs: 0 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const u = String(url);
      const m = /\/api\/v1\/transactions\/([^?]+)/.exec(u);
      if (m) {
        const body = mirror.get(decodeURIComponent(m[1]));
        return body ? Response.json(body) : new Response("not found", { status: 404 });
      }
      return realFetch(url);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setX402ServerForTests(null);
  __setGatePollForTests(null);
});

afterAll(() => {
  for (const k of ["CHAIN_MODE", "OWNER_SECRET", "X402_PAY_TO"]) delete process.env[k];
  resetEnv();
});

const mirrorId = (txId: string) => txId.replace("@", "-").replace(/\.(\d+)$/, "-$1");

describe("one x402 payment buys one siege", () => {
  it("the same PAYMENT-SIGNATURE sent twice concurrently starts exactly one siege", async () => {
    const server = fakeServer();
    const { b64, txId } = hederaTxBase64();
    server.settlePayment.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { success: true, transaction: txId, network: "hedera:testnet", payer: "0.0.1234" };
    });
    const [a, b] = await Promise.all([startRoute.POST(paidStart(b64)), startRoute.POST(paidStart(b64))]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 402]);
    const refused = a.status === 402 ? a : b;
    expect(((await refused.json()) as { error?: string }).error).toBe("payment_already_used");
    expect(sieges()).toHaveLength(1);
    expect(receipts().filter((r) => r.txId === txId)).toHaveLength(1);
    expect(server.settlePayment).toHaveBeenCalledTimes(1);
  });

  it("a replay AFTER the first one finished is refused too (and settles nothing)", async () => {
    const server = fakeServer();
    const { b64, txId } = hederaTxBase64();
    server.settlePayment.mockResolvedValue({ success: true, transaction: txId, network: "hedera:testnet", payer: "0.0.1234" });
    expect((await startRoute.POST(paidStart(b64))).status).toBe(200);
    expect((await startRoute.POST(paidStart(b64))).status).toBe(402);
    expect(sieges()).toHaveLength(1);
    expect(server.settlePayment).toHaveBeenCalledTimes(1);
  });

  it("a payment rejected at verify releases its claim (nothing moved)", async () => {
    const server = fakeServer();
    const { b64 } = hederaTxBase64();
    server.verifyPayment.mockResolvedValueOnce({ isValid: false, invalidReason: "insufficient_funds" } as never);
    expect((await startRoute.POST(paidStart(b64))).status).toBe(402);
    expect(receipts()).toHaveLength(0);
  });
});

describe("ambiguous settlement is resolved, never forgotten", () => {
  const timeout = () => Object.assign(new Error("timed out"), { name: "FacilitatorTimeoutError", operation: "settle" });

  it("settle timeout but the transfer landed (mirror SUCCESS) -> the siege starts", async () => {
    const server = fakeServer();
    const { b64, txId } = hederaTxBase64();
    server.settlePayment.mockRejectedValue(timeout());
    mirror.set(mirrorId(txId), { transactions: [{ result: "SUCCESS", nonce: 0 }] });
    const res = await startRoute.POST(paidStart(b64));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { siegeId: string; receipt: { txId: string } };
    expect(body.receipt.txId).toBe(txId);
    expect(receipts()).toMatchObject([{ txId, state: "settled", siegeId: body.siegeId }]);
  });

  it("settle timeout and the mirror has not seen it -> 502 payment_pending with a receipt the worker resolves and refunds", async () => {
    const server = fakeServer();
    const { b64, txId } = hederaTxBase64();
    server.settlePayment.mockRejectedValue(timeout());
    const res = await startRoute.POST(paidStart(b64));
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: string; receiptId: string; txId: string };
    expect(body).toMatchObject({ error: "payment_pending", txId });
    expect(receipts()).toMatchObject([{ id: body.receiptId, state: "pending_settlement", payer: "0.0.1234", siegeId: null }]);
    expect(sieges()).toHaveLength(0);

    // Later the transfer shows up: the worker turns it into a refund (no siege was bought with it).
    mirror.set(mirrorId(txId), { transactions: [{ result: "SUCCESS", nonce: 0 }] });
    const rep = await reconcileReceipts();
    expect(rep.resolved).toEqual([{ id: body.receiptId, state: "refund_due" }]);
    // No Hedera operator in this test: the refund transfer fails and is parked for a human, never retried.
    expect(rep.failed.map((f) => f.id)).toEqual([body.receiptId]);
    expect(receipts()[0].state).toBe("refund_failed");
    expect((await reconcileReceipts()).failed).toHaveLength(0);
  });

  it("success:false 'transaction_failed' is ambiguous too; a definitive verification reason is a plain 402", async () => {
    const server = fakeServer();
    const one = hederaTxBase64();
    server.settlePayment.mockResolvedValueOnce({ success: false, errorReason: "transaction_failed", transaction: "", network: "hedera:testnet" });
    mirror.set(mirrorId(one.txId), { transactions: [{ result: "INSUFFICIENT_PAYER_BALANCE", nonce: 0 }] });
    expect((await startRoute.POST(paidStart(one.b64))).status).toBe(402); // mirror: failed -> nothing moved
    const two = hederaTxBase64();
    server.settlePayment.mockResolvedValueOnce({ success: false, errorReason: "invalid_exact_hedera_payload_signature_invalid", transaction: "", network: "hedera:testnet" });
    expect((await startRoute.POST(paidStart(two.b64))).status).toBe(402);
    expect(receipts()).toHaveLength(0);
  });

  it("a pending receipt the mirror never sees is failed after the tx validity window and the agent's spend is released", async () => {
    process.env.CHAIN_MODE = "stub"; // a stub account is enough here (testnet would fund one from the operator)
    resetEnv();
    const agent = await createAgent({ name: "Vex" });
    process.env.CHAIN_MODE = "testnet";
    resetEnv();
    const caps = await checkCaps(agent.id, CASTLE, FEE);
    expect(caps.ok).toBe(true);
    if (!caps.ok) return;
    const id = "rcpt_pending_old";
    db()
      .insert(schema.paymentReceipts)
      .values({ id, payer: agent.accountId, amountTinybar: Number(FEE), asset: "0.0.0", txId: "0.0.9185802@1762400000.000000999", state: "pending_settlement", createdAt: new Date(Date.now() - 11 * 60_000).toISOString() })
      .run();
    await holdSpend(caps.reservationId, id);
    expect((await checkCaps(agent.id, CASTLE, String(2 * Number(FEE)))).ok).toBe(false); // 1 held + 2 > 2 ℏ cap
    await reconcileReceipts();
    expect(db().select().from(schema.agentSpend).where(eq(schema.agentSpend.id, caps.reservationId)).get()!.state).toBe("void");
  });
});

describe("spend-control refusals are recognised in both modes", () => {
  it("matches the x402 client's spendControls message and our stub error", () => {
    expect(isSpendControlRefusal(new Error("Failed to create payment payload: All payment requirements were rejected by spendControls.allowedAssets maxAmountPerPayment"))).toBe(true);
    expect(isSpendControlRefusal(new SpendControlError("2", "1"))).toBe(true);
    expect(isSpendControlRefusal(new Error("fetch failed"))).toBe(false);
  });
});
