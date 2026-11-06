import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnv } from "@/lib/config/env";
import { accountEvmAddress, resetMirrorCache, toLongZero, topicSubmitResult, transactionResult } from "./mirror";

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

  it("topicSubmitResult finds an in-doubt HCS submit's topic sequence number", async () => {
    const urls: string[] = [];
    const answers: Record<string, Response> = {
      "/transactions/0.0.5-1-1": Response.json({ transactions: [{ result: "SUCCESS", nonce: 0, consensus_timestamp: "1700000000.000000042" }] }),
      "/topics/messages/1700000000.000000042": Response.json({ sequence_number: 17, topic_id: "0.0.7001" }),
      "/transactions/0.0.5-1-2": Response.json({ transactions: [{ result: "INVALID_TOPIC_ID", nonce: 0, consensus_timestamp: "1.2" }] }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        const p = decodeURIComponent(String(u).split("/api/v1")[1]);
        urls.push(p);
        return answers[p] ?? new Response("", { status: 404 });
      }),
    );
    expect(await topicSubmitResult("0.0.5@1.1")).toEqual({ state: "landed", seq: 17 });
    expect(await topicSubmitResult("0.0.5@1.2")).toEqual({ state: "failed", reason: "INVALID_TOPIC_ID" });
    expect(await topicSubmitResult("0.0.5@1.3")).toEqual({ state: "unknown" });
    expect(urls).toEqual(["/transactions/0.0.5-1-1", "/topics/messages/1700000000.000000042", "/transactions/0.0.5-1-2", "/transactions/0.0.5-1-3"]);
  });
});
