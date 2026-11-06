import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, ResourceInfo } from "@x402/core/types";
import { resetEnv } from "@/lib/config/env";
import type { Castle } from "@/lib/types";
import { gate, STUB_PAYMENT_HEADER } from "@/lib/pay";
import { __setX402ServerForTests, type GateServer } from "@/lib/pay/x402";

const castle = {
  id: "c1",
  name: "Granite Hold",
  fee: "100000000",
  asset: { id: "0.0.0", decimals: 8, symbol: "HBAR" },
} as unknown as Castle;

const url = "http://localhost:3000/api/siege/start";
const post = (headers: Record<string, string> = {}) => new Request(url, { method: "POST", headers, body: "{}" });

beforeEach(() => {
  process.env.CHAIN_MODE = "stub";
  resetEnv();
});

afterEach(() => {
  process.env.CHAIN_MODE = "stub";
  delete process.env.X402_PAY_TO;
  delete process.env.OWNER_SECRET;
  resetEnv();
  __setX402ServerForTests(null);
});

describe("gate (stub)", () => {
  it("answers 402 with x402-shaped requirements", async () => {
    const r = await gate(post(), { castle, description: "Siege Granite Hold" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(402);
    const body = r.body as { x402Version: number; accepts: PaymentRequirements[]; resource: ResourceInfo };
    expect(body.x402Version).toBe(2);
    expect(body.accepts[0]).toMatchObject({ scheme: "exact", network: "hedera:testnet", asset: "0.0.0", amount: castle.fee, maxTimeoutSeconds: 180 });
    expect(body.resource.url).toBe(url);
    expect(decodePaymentRequiredHeader(r.headers["PAYMENT-REQUIRED"]).accepts[0].amount).toBe(castle.fee);
  });

  it("accepts the stub header and returns a stub receipt", async () => {
    const r = await gate(post({ [STUB_PAYMENT_HEADER]: "0.0.stub-agent-1" }), { castle, description: "x" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt).toMatchObject({ free: false, payer: "0.0.stub-agent-1", amount: castle.fee, asset: "0.0.0", stub: true });
    expect(r.receipt.txId).toMatch(/^stub:x402@\d+/);
    expect(decodePaymentResponseHeader(r.headers["PAYMENT-RESPONSE"]).success).toBe(true);
  });
});

describe("gate (testnet, mocked facilitator)", () => {
  function fake() {
    const reqs: PaymentRequirements[] = [
      { scheme: "exact", network: "hedera:testnet", asset: "0.0.0", amount: castle.fee, payTo: "0.0.4242", maxTimeoutSeconds: 180, extra: { feePayer: "0.0.98" } },
    ];
    const server = {
      buildPaymentRequirements: vi.fn(async () => reqs),
      createPaymentRequiredResponse: vi.fn(async (accepts: PaymentRequirements[], resource: ResourceInfo, error?: string) => ({
        x402Version: 2,
        resource,
        accepts,
        ...(error ? { error } : {}),
      })),
      findMatchingRequirements: vi.fn((available: PaymentRequirements[], p: PaymentPayload) =>
        available.find((r) => r.amount === p.accepted.amount && r.payTo === p.accepted.payTo),
      ),
      verifyPayment: vi.fn(async () => ({ isValid: true, payer: "0.0.777" })),
      settlePayment: vi.fn(async () => ({ success: true, transaction: "0.0.777@1700000000.000000001", network: "hedera:testnet" as const, payer: "0.0.777" })),
    };
    __setX402ServerForTests(server as unknown as GateServer);
    return { server, reqs };
  }

  beforeEach(() => {
    process.env.CHAIN_MODE = "testnet";
    process.env.X402_PAY_TO = "0.0.4242";
    process.env.OWNER_SECRET = "test-owner-secret-0123";
    resetEnv();
  });

  it("ignores the stub header", async () => {
    const { server } = fake();
    const r = await gate(post({ [STUB_PAYMENT_HEADER]: "0.0.stub-agent-1" }), { castle, description: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(402);
    expect(server.buildPaymentRequirements).toHaveBeenCalledWith(
      expect.objectContaining({ payTo: "0.0.4242", price: { asset: "0.0.0", amount: castle.fee }, network: "hedera:testnet" }),
    );
    expect(server.verifyPayment).not.toHaveBeenCalled();
    expect(server.settlePayment).not.toHaveBeenCalled();
    expect(r.headers["PAYMENT-REQUIRED"]).toBeTruthy();
  });

  it("verifies then settles a real payment header", async () => {
    const { server, reqs } = fake();
    const payload: PaymentPayload = { x402Version: 2, accepted: reqs[0], payload: { transaction: "base64tx" } };
    const r = await gate(post({ "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) }), { castle, description: "x" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(server.verifyPayment).toHaveBeenCalledOnce();
    expect(server.settlePayment).toHaveBeenCalledOnce();
    expect(r.receipt).toMatchObject({ free: false, txId: "0.0.777@1700000000.000000001", payer: "0.0.777", amount: castle.fee });
    expect(r.receipt.stub).toBeUndefined();
    expect(r.receipt.hashscanUrl).toContain("hashscan.io/testnet/transaction/");
    expect(r.headers["PAYMENT-RESPONSE"]).toBeTruthy();
  });

  it("402s an invalid payment and 502s a facilitator timeout", async () => {
    const { server, reqs } = fake();
    const payload: PaymentPayload = { x402Version: 2, accepted: reqs[0], payload: {} };
    const hdr = { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) };

    server.verifyPayment.mockResolvedValueOnce({ isValid: false, invalidReason: "insufficient_funds" } as never);
    const bad = await gate(post(hdr), { castle, description: "x" });
    expect(!bad.ok && bad.status).toBe(402);
    expect(!bad.ok && (bad.body as { error?: string }).error).toBe("insufficient_funds");

    const timeout = Object.assign(new Error("timed out"), { name: "FacilitatorTimeoutError", operation: "settle" });
    server.settlePayment.mockRejectedValueOnce(timeout);
    const slow = await gate(post(hdr), { castle, description: "x" });
    expect(!slow.ok && slow.status).toBe(502);
  });
});
