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

describe("accountTransfers", () => {
  const OP = "0.0.11329863";
  const page1 = {
    transactions: [
      {
        transaction_id: "0.0.9185802-1793983423-475432254",
        memo_base64: Buffer.from(" siege:abcd2345 ").toString("base64"),
        consensus_timestamp: "1793983429.213832557",
        result: "SUCCESS",
        transfers: [
          { account: OP, amount: 100000000 },
          { account: "0.0.3", amount: 20 },
          { account: "0.0.9185802", amount: -100000020 },
        ],
      },
      // the operator paying out: not a deposit
      { transaction_id: `${OP}-1793983500-1`, memo_base64: "", consensus_timestamp: "1793983501.0", result: "SUCCESS", transfers: [{ account: OP, amount: -5 }] },
    ],
    links: { next: "/api/v1/transactions?account.id=0.0.11329863&timestamp=gt:1793983429.213832557&limit=100" },
  };
  const page2 = {
    transactions: [
      {
        transaction_id: "0.0.55-1793983600-9",
        memo_base64: "",
        consensus_timestamp: "1793983605.5",
        result: "SUCCESS",
        transfers: [
          { account: OP, amount: 7 },
          { account: OP, amount: 3 },
        ],
      },
    ],
    links: { next: null },
  };

  it("builds the query, follows links.next and decodes memo, payer and amount", async () => {
    process.env.CHAIN_MODE = "testnet";
    resetEnv();
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (u: string) => {
        urls.push(u);
        return Response.json(urls.length === 1 ? page1 : page2);
      }),
    );
    const { accountTransfers } = await import("./mirror");
    const out = await accountTransfers(OP, { sinceMs: 1793983300000 });
    expect(out).toEqual([
      { txId: "0.0.9185802-1793983423-475432254", payer: "0.0.9185802", memo: "siege:abcd2345", amountToAccount: "100000000", consensusTimestamp: "1793983429.213832557" },
      { txId: "0.0.55-1793983600-9", payer: "0.0.55", memo: "", amountToAccount: "10", consensusTimestamp: "1793983605.5" },
    ]);
    expect(urls).toHaveLength(2);
    const q = new URL(urls[0]!).searchParams;
    expect(q.get("account.id")).toBe(OP);
    expect(q.get("transactiontype")).toBe("CRYPTOTRANSFER");
    expect(q.get("result")).toBe("success");
    expect(q.get("timestamp")).toBe("gte:1793983300.000000000");
    expect(q.get("order")).toBe("asc");
    expect(q.get("limit")).toBe("100");
    expect(urls[1]).toMatch(/\/api\/v1\/transactions\?account\.id=/);
    expect(urls[1]).not.toMatch(/api\/v1\/api\/v1/);
  });
});
