import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnv } from "@/lib/config/env";
import { createPayerFetch, STUB_PAYMENT_HEADER, stubPaymentRequired } from "@/lib/pay";

const HBAR = 100_000_000;

function fakeServer(fee: number) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (!headers.get(STUB_PAYMENT_HEADER)) {
      return Response.json(stubPaymentRequired({ fee: String(fee) }, String(input), "siege"), { status: 402 });
    }
    return Response.json({ ok: true, payer: headers.get(STUB_PAYMENT_HEADER), body: init?.body ?? null });
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

beforeEach(() => {
  process.env.CHAIN_MODE = "stub";
  resetEnv();
});

describe("stub payer fetch", () => {
  it("pays a 402 within the cap by retrying with the stub header", async () => {
    const base = fakeServer(1 * HBAR);
    const f = createPayerFetch({ accountId: "0.0.stub-agent-1", perPaymentCap: String(2 * HBAR) }, base);
    const res = await f("http://x/api/siege/start", { method: "POST", body: JSON.stringify({ castleId: "c1" }) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, payer: "0.0.stub-agent-1", body: '{"castleId":"c1"}' });
    expect(base).toHaveBeenCalledTimes(2);
  });

  it("refuses a 402 over the cap without paying", async () => {
    const base = fakeServer(3 * HBAR);
    const f = createPayerFetch({ accountId: "0.0.stub-agent-1", perPaymentCap: String(2 * HBAR) }, base);
    await expect(f("http://x/api/siege/start", { method: "POST" })).rejects.toThrow(/spend control: payment exceeds cap/);
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("passes non-402 responses through untouched", async () => {
    const base = vi.fn(async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const f = createPayerFetch({ accountId: "0.0.1", perPaymentCap: "1" }, base);
    expect((await f("http://x")).status).toBe(404);
  });
});
