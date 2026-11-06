import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnv } from "@/lib/config/env";
import { accountEvmAddress, resetMirrorCache, toLongZero, transactionResult } from "./mirror";

const ALIAS = "0x1111111111111111111111111111111111111111";

beforeEach(() => {
  process.env.CHAIN_MODE = "testnet";
  process.env.OWNER_SECRET = "test-owner-secret-0123";
  resetEnv();
  resetMirrorCache();
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.CHAIN_MODE = "stub";
  delete process.env.OWNER_SECRET;
  resetEnv();
});

describe("mirror", () => {
  it("strict lookups throw on a mirror failure instead of falling back to long-zero", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (calls === 1) throw new TypeError("fetch failed");
        return Response.json({ evm_address: ALIAS });
      }),
    );
    await expect(accountEvmAddress("0.0.1234", { strict: true })).rejects.toThrow(/mirror_unavailable/);
    expect(await accountEvmAddress("0.0.1234", { strict: true })).toBe(ALIAS);
    expect(await accountEvmAddress("0.0.1234")).toBe(ALIAS); // cached
    resetMirrorCache();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("fetch failed"); }));
    expect(await accountEvmAddress("0.0.1234")).toBe(toLongZero("0.0.1234")); // lenient fallback unchanged
  });

  it("transactionResult reads consensus results (404 = unknown, duplicates ignored)", async () => {
    const answers: Record<string, Response> = {
      "0.0.5-1-1": Response.json({ transactions: [{ result: "SUCCESS", nonce: 0 }, { result: "DUPLICATE_TRANSACTION", nonce: 0 }] }),
      "0.0.5-1-2": Response.json({ transactions: [{ result: "INSUFFICIENT_PAYER_BALANCE", nonce: 0 }] }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => answers[decodeURIComponent(String(u).split("/transactions/")[1])] ?? new Response("", { status: 404 })),
    );
    expect(await transactionResult("0.0.5@1.1")).toEqual({ state: "success" });
    expect(await transactionResult("0.0.5@1.2")).toEqual({ state: "failed", result: "INSUFFICIENT_PAYER_BALANCE" });
    expect(await transactionResult("0.0.5@1.3")).toEqual({ state: "unknown" });
  });
});
