import { afterEach, beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
process.env.ZG_MOCK = "1";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { WOODEN_BREAK } from "@/lib/fixtures/raids";
import type { PaidReceipt } from "@/lib/types";
import * as proxy from "@/lib/proxy";
import { getSiege, siege, verifier } from "./index";

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

  /** The proxy record behind the final guardian reply of a broken siege. */
  function finalRecord(siegeId: string) {
    const msg = db().select().from(schema.messages).where(eq(schema.messages.siegeId, siegeId)).all().filter((m) => m.role === "guardian").at(-1)!;
    return { msg, requestId: msg.requestId! };
  }
  const tamper = (requestId: string, set: Partial<typeof schema.proxyRecords.$inferInsert>) =>
    db().update(schema.proxyRecords).set(set).where(eq(schema.proxyRecords.requestId, requestId)).run();

  it("rejects a record made on another castle's key (6b)", async () => {
    const id = await breakWooden();
    tamper(finalRecord(id).requestId, { castleId: "castle_granite_hold" });
    expect(await verifier.verify(id)).toMatchObject({ ok: false, reason: "proxy_record_wrong_castle" });
  });

  it("rejects a record from another siege or another turn (6c)", async () => {
    const id = await breakWooden();
    const { requestId, msg } = finalRecord(id);
    tamper(requestId, { siegeId: "siege_other" });
    expect(await verifier.verify(id)).toMatchObject({ ok: false, reason: "proxy_record_wrong_siege_or_turn" });
    tamper(requestId, { siegeId: id, turn: msg.turn - 1 });
    expect(await verifier.verify(id)).toMatchObject({ ok: false, reason: "proxy_record_wrong_siege_or_turn" });
    tamper(requestId, { turn: msg.turn });
    expect(await verifier.verify(id)).toMatchObject({ ok: true });
  });

  it("rejects a record where 0G's response made no protected-tool call (6d)", async () => {
    const id = await breakWooden();
    tamper(finalRecord(id).requestId, { protectedToolCalled: false });
    expect(await verifier.verify(id)).toMatchObject({ ok: false, reason: "proxy_saw_no_open_vault" });
  });

  it("rejects a final reply whose request id points at another siege's record", async () => {
    const a = await breakWooden();
    const b = await breakWooden();
    const { msg } = finalRecord(b);
    db().update(schema.messages).set({ requestId: finalRecord(a).requestId }).where(eq(schema.messages.id, msg.id)).run();
    // requestId is not part of the transcript hash, so this reaches the record check.
    expect(await verifier.verify(b)).toMatchObject({ ok: false, reason: "proxy_record_wrong_siege_or_turn" });
  });

  it("a castle with a custom protectedTool breaks with that tool and verifies (0G guardian = stub guardian)", async () => {
    db().update(schema.castles).set({ protectedTool: "release_funds" }).where(eq(schema.castles.id, WOODEN)).run();
    const id = await breakWooden();
    expect(getSiege(id)).toMatchObject({ status: "broken" });
    const { msg, requestId } = finalRecord(id);
    expect(JSON.parse(msg.toolCalls ?? "[]")).toEqual([expect.objectContaining({ name: "release_funds" })]);
    expect(proxy.record(requestId)).toMatchObject({ protectedToolCalled: true });
    expect(await verifier.verify(id)).toMatchObject({ ok: true });
  });

  it("rejects stub request ids while the 0G guardian is active", async () => {
    process.env.GUARDIAN_MODE = "stub";
    const id = await breakWooden();
    process.env.GUARDIAN_MODE = "0g";
    expect(await verifier.verify(id)).toMatchObject({ ok: false, reason: "stub_reply_while_0g" });
  });
});
