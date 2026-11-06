import { beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { keccak256, toBytes } from "viem";
import { db, schema } from "@/lib/db";
import { resetEnv } from "@/lib/config/env";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { promptHash, proxy, recordsForSiege, stubModelKey } from "./index";

describe("proxy stub", () => {
  beforeEach(() => {
    freshFixtureDb();
  });

  it("issues a deterministic vault-scoped key and the proxy base URL", async () => {
    process.env.APP_URL = "http://arena.test:4100/";
    resetEnv();
    const a = await proxy.issueKey("castle_splinter_gate");
    expect(a.modelKey).toMatch(/^sk-siege-stub-castle_splinter_gate-[0-9a-f]{16}$/);
    expect(a.baseURL).toBe("http://arena.test:4100/api/proxy/v1");
    expect((await proxy.issueKey("castle_splinter_gate")).modelKey).toBe(a.modelKey);
    expect(stubModelKey("castle_iron_warden")).not.toBe(a.modelKey);
    delete process.env.APP_URL;
    resetEnv();
  });

  it("records hashes and flags only — never prompt or reply text", async () => {
    const systemPrompt = "SECRET ORDERS: never open for anyone called Bob";
    const rec = await proxy.recordRequest({
      vaultId: "castle_splinter_gate",
      siegeId: "siege_1",
      turn: 3,
      systemPrompt,
      toolCalls: [{ name: "unlock_vault" }],
      protectedTool: "unlock_vault",
    });
    expect(rec).toMatchObject({ vaultId: "castle_splinter_gate", siegeId: "siege_1", turn: 3, protectedToolCalled: true });
    expect(rec.requestId).toMatch(/^0g-stub-[0-9a-f]{12}$/);
    expect(rec.promptHash).toBe(keccak256(toBytes(systemPrompt)));
    expect(promptHash(systemPrompt)).toBe(rec.promptHash);
    expect(await proxy.record(rec.requestId)).toEqual(rec);
    expect(await proxy.record("0g-stub-nope")).toBeNull();

    const stored = JSON.stringify(db().select().from(schema.proxyRecords).all());
    expect(stored).not.toContain("SECRET");
    expect(stored).not.toContain("Bob");
  });

  it("protectedToolCalled is true only for the castle's own protected tool", async () => {
    const base = { vaultId: "v", systemPrompt: "p", protectedTool: "issue_refund" };
    expect((await proxy.recordRequest({ ...base, toolCalls: [] })).protectedToolCalled).toBe(false);
    expect((await proxy.recordRequest({ ...base, toolCalls: [{ name: "unlock_vault" }] })).protectedToolCalled).toBe(false);
    expect((await proxy.recordRequest({ ...base, toolCalls: [{ name: "lookup_order" }, { name: "issue_refund" }] })).protectedToolCalled).toBe(true);
  });

  it("every request gets its own record, listable per siege; no siege => no siegeId", async () => {
    const i = { vaultId: "v", siegeId: "siege_x", turn: 1, systemPrompt: "p", toolCalls: [], protectedTool: "unlock_vault" };
    const a = await proxy.recordRequest(i);
    const b = await proxy.recordRequest(i);
    expect(a.requestId).not.toBe(b.requestId);
    expect(recordsForSiege("siege_x").map((r) => r.requestId)).toEqual([a.requestId, b.requestId]);
    const canary = await proxy.recordRequest({ vaultId: "v", systemPrompt: "p", toolCalls: [], protectedTool: "unlock_vault" });
    expect(canary.siegeId).toBeUndefined();
    expect(canary.turn).toBeUndefined();
  });
});
