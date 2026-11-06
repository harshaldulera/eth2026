import { afterEach, beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
process.env.ZG_MOCK = "1";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { WOODEN_BREAK } from "@/lib/fixtures/raids";
import type { PaidReceipt } from "@/lib/types";
import { siege, verifier } from "./index";

const WOODEN = "castle_splinter_gate";
const paid = (): Omit<PaidReceipt, "siegeId"> => ({ free: false, txId: `stub:x402@${Date.now()}`, payer: "0.0.raider", amount: "50000000", asset: "0.0.0", network: "hedera:testnet", hashscanUrl: "#stub", stub: true });

async function breakWooden() {
  const s = await siege.start({ castleId: WOODEN, raider: "0.0.raider", receipt: paid() });
  for (const t of WOODEN_BREAK) {
    const r = await siege.message(s.id, t);
    if (!r.ok || r.siege.status !== "in_progress") break;
  }
  return s.id;
}

describe("verifier with the 0G guardian (mock upstream)", () => {
  beforeEach(() => {
    freshFixtureDb();
    process.env.GUARDIAN_MODE = "0g";
    process.env.ZG_ALLOW_MOCK_VERIFY = "1";
  });
  afterEach(() => {
    delete process.env.GUARDIAN_MODE;
    delete process.env.ZG_ALLOW_MOCK_VERIFY;
  });

  it("accepts a break backed by a matching proxy record", async () => {
    const id = await breakWooden();
    expect(await verifier.verify(id)).toMatchObject({ ok: true });
  });

  it("rejects a mock response unless explicitly allowed", async () => {
    const id = await breakWooden();
    delete process.env.ZG_ALLOW_MOCK_VERIFY;
    expect(await verifier.verify(id)).toMatchObject({ ok: false, reason: "mock_response" });
  });

  it("rejects when the castle's orders changed after the break (prompt hash)", async () => {
    const id = await breakWooden();
    db().update(schema.castles).set({ orders: "different orders" }).where(eq(schema.castles.id, WOODEN)).run();
    expect(await verifier.verify(id)).toMatchObject({ ok: false, reason: "prompt_hash_mismatch" });
  });

  it("rejects a reply with no proxy record", async () => {
    const id = await breakWooden();
    db().delete(schema.proxyRecords).run();
    expect(await verifier.verify(id)).toMatchObject({ ok: false, reason: "no_proxy_record" });
  });

  it("rejects stub request ids while the 0G guardian is active", async () => {
    process.env.GUARDIAN_MODE = "stub";
    const id = await breakWooden();
    process.env.GUARDIAN_MODE = "0g";
    expect(await verifier.verify(id)).toMatchObject({ ok: false, reason: "stub_reply_while_0g" });
  });
});
