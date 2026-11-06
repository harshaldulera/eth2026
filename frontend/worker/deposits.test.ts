import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { getIntent, onDepositConfirmed, resetDepositHandlers } from "@/lib/pay/deposits";
import { depositsTick, resetDepositsTick } from "./deposits";

const NOW = Date.now();
const row = (o: Record<string, unknown> = {}) => ({
  id: "w1",
  kind: "vault" as const,
  refId: "c",
  code: "wwww2222",
  memo: "siege:wwww2222",
  amountTinybar: 100,
  createdAt: new Date(NOW - 60_000).toISOString(),
  expiresAt: new Date(NOW + 40 * 60_000).toISOString(),
  ...o,
});

beforeEach(() => {
  process.env.CHAIN_MODE = "testnet";
  process.env.HEDERA_OPERATOR_ID = "0.0.4242";
  process.env.OWNER_SECRET = "test-owner-secret-0123";
  resetEnv();
  freshFixtureDb();
  resetDepositHandlers();
  resetDepositsTick();
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.CHAIN_MODE = "stub";
  delete process.env.HEDERA_OPERATOR_ID;
  delete process.env.OWNER_SECRET;
  resetEnv();
});

describe("depositsTick", () => {
  it("does nothing, and never calls the mirror, with no open intents", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await depositsTick(NOW)).toBe(0);
    expect(f).not.toHaveBeenCalled();
  });

  it("reads the mirror, funds a matching intent, and throttles to 5 s", async () => {
    const h = vi.fn(async () => {});
    onDepositConfirmed("vault", h);
    db().insert(schema.depositIntents).values(row()).run();
    const f = vi.fn(async () =>
      Response.json({
        transactions: [
          {
            transaction_id: "0.0.9-1-1",
            memo_base64: Buffer.from("siege:wwww2222").toString("base64"),
            consensus_timestamp: `${Math.floor(NOW / 1000)}.0`,
            result: "SUCCESS",
            transfers: [{ account: "0.0.4242", amount: 100 }],
          },
        ],
        links: {},
      }),
    );
    vi.stubGlobal("fetch", f);
    await depositsTick(NOW);
    expect(getIntent("w1")).toMatchObject({ state: "funded", payer: "0.0.9" });
    expect(h).toHaveBeenCalledTimes(1);
    expect(String((f.mock.calls as unknown as unknown[][])[0]![0])).toContain("account.id=0.0.4242");
    db().insert(schema.depositIntents).values(row({ id: "w2", code: "yyyy2222", memo: "siege:yyyy2222" })).run();
    await depositsTick(NOW + 1000);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries a failed handler after 30 s backoff, at most 5 attempts", async () => {
    let n = 0;
    onDepositConfirmed("vault", async () => {
      n++;
      throw new Error("down");
    });
    db().insert(schema.depositIntents).values(row({ state: "failed", attempts: 1, receivedTinybar: 100 })).run();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ transactions: [], links: {} })));
    await depositsTick(NOW);
    expect(n).toBe(1);
    await depositsTick(NOW + 10_000);
    expect(n).toBe(1);
    for (let k = 1; k <= 8; k++) await depositsTick(NOW + k * 31_000);
    expect(n).toBe(4); // attempts 1 + 4 retries = 5, then it stops
    expect(getIntent("w1")!.attempts).toBe(5);
  });

  it("expires an unpaid intent past its window", async () => {
    db().insert(schema.depositIntents).values(row({ expiresAt: new Date(NOW - 1000).toISOString() })).run();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ transactions: [], links: {} })));
    await depositsTick(NOW);
    expect(getIntent("w1")!.state).toBe("expired");
  });
});
