import { afterEach, beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
process.env.ZG_MOCK = "1";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { SDK_FIXTURE_CASTLE, sdkFixtureCastleRow } from "@/lib/fixtures/castles";
import { WOODEN_BREAK } from "@/lib/fixtures/raids";
import { startFakeHarness, type FakeHarness } from "@/lib/guard/testing";
import * as proxy from "@/lib/proxy";
import type { ToolDef } from "@/lib/proxy";
import { sdkTiming } from "@/lib/transport/sdk";
import type { PaidReceipt } from "@/lib/types";
import { siege, verifier } from "./index";

/** Part 2a verifier branch: an SDK break is checked against the prompt hash the self-check pinned. */

const SDK = SDK_FIXTURE_CASTLE.id;
const TOOL = SDK_FIXTURE_CASTLE.protectedTool ?? "issue_refund";
const SYSTEM = "You are Penny. Refunds only via the returns form.";
const TOOLS: ToolDef[] = [{ type: "function", function: { name: TOOL, description: "Refund", parameters: { type: "object", properties: {} } } }];
const paid = (): Omit<PaidReceipt, "siegeId"> => ({ free: false, txId: `stub:x402@${Date.now()}`, payer: "0.0.raider", amount: "100000000", asset: "0.0.0", network: "hedera:testnet", hashscanUrl: "#stub", stub: true });
const PINNED = proxy.systemPromptHash([{ role: "system", content: SYSTEM }]);

let harness: FakeHarness | null = null;

async function breakSdk(): Promise<string> {
  harness = startFakeHarness({ castleId: SDK, protectedTool: TOOL, system: SYSTEM, tools: TOOLS });
  await new Promise((r) => setTimeout(r, 30));
  const s = await siege.start({ castleId: SDK, raider: "0.0.raider", receipt: paid() });
  for (const t of WOODEN_BREAK) {
    const r = await siege.message(s.id, t);
    if (!r.ok || r.siege.status !== "in_progress") break;
  }
  await harness.stop();
  harness = null;
  expect(db().select().from(schema.sieges).where(eq(schema.sieges.id, s.id)).get()!.status).toBe("broken");
  return s.id;
}

const setPinned = (h: string | null) => db().update(schema.castles).set({ pinnedPromptHash: h }).where(eq(schema.castles.id, SDK)).run();

describe("verifier: SDK castles compare to the pinned prompt hash", () => {
  beforeEach(() => {
    freshFixtureDb();
    db().insert(schema.castles).values({ ...sdkFixtureCastleRow(), pinnedPromptHash: PINNED }).run();
    process.env.ZG_ALLOW_MOCK_VERIFY = "1";
    sdkTiming.pollMs = 10;
  });
  afterEach(async () => {
    await harness?.stop();
    harness = null;
    delete process.env.ZG_ALLOW_MOCK_VERIFY;
    sdkTiming.pollMs = 300;
  });

  it("passes when the break's record carries the pinned hash", async () => {
    const id = await breakSdk();
    expect(await verifier.verify(id)).toMatchObject({ ok: true });
  });

  it("fails prompt_hash_mismatch when the pinned hash differs", async () => {
    const id = await breakSdk();
    setPinned("f".repeat(64));
    expect(await verifier.verify(id)).toMatchObject({ ok: false, reason: "prompt_hash_mismatch" });
  });

  it("fails no_pinned_prompt_hash when nothing was pinned", async () => {
    const id = await breakSdk();
    setPinned(null);
    expect(await verifier.verify(id)).toMatchObject({ ok: false, reason: "no_pinned_prompt_hash" });
  });

  it("still refuses a mock record unless allowed (model-backed guardian)", async () => {
    const id = await breakSdk();
    delete process.env.ZG_ALLOW_MOCK_VERIFY;
    process.env.GUARDIAN_MODE = "0g";
    try {
      expect(await verifier.verify(id)).toMatchObject({ ok: false, reason: "mock_response" });
    } finally {
      delete process.env.GUARDIAN_MODE;
    }
  });

  it("accepts a mock record in full stub mode (stub chain + stub guardian: no real money)", async () => {
    const id = await breakSdk();
    delete process.env.ZG_ALLOW_MOCK_VERIFY;
    process.env.GUARDIAN_MODE = "stub";
    try {
      expect(await verifier.verify(id)).toMatchObject({ ok: true });
    } finally {
      delete process.env.GUARDIAN_MODE;
    }
  });
});
