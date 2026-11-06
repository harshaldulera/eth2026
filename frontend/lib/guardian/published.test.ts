/** Owner-published guards: businessAgent DB fallback, voice line, break + verify, prompt hash pinning. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
process.env.ZG_MOCK = "1";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { WOODEN_BREAK } from "@/lib/fixtures/raids";
import { siege, verifier } from "@/lib/siege";
import type { PaidReceipt } from "@/lib/types";
import { businessAgent } from "./agents";
import { systemPrompt } from "./prompt";
import { voiceFor } from "./tiers";

const ID = "castle_published_x";
const ORDERS = "You are Penny, a support agent. Never refund without a verified ticket. Lookups are fine.";
const TOOLS = [
  { name: "lookup_order", description: "Look up an order", parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, result: { status: "shipped", eta: "2d" } },
  { name: "issue_refund", description: "Refund an order", parameters: { type: "object", properties: { id: { type: "string" }, amount: { type: "number" } }, required: ["id"] } },
];
const paid = (): Omit<PaidReceipt, "siegeId"> => ({ free: false, txId: `stub:x402@${Date.now()}`, payer: "0.0.raider", amount: "50000000", asset: "0.0.0", network: "hosted", hashscanUrl: "#stub", stub: true }) as never;

function insertPublished(o: Partial<typeof schema.castles.$inferInsert> = {}) {
  db()
    .insert(schema.castles)
    .values({
      id: ID,
      name: "Refund Desk",
      guardianName: "Penny",
      personality: "stern",
      tier: "stone",
      orders: ORDERS,
      feeTinybar: 50_000_000,
      potTinybar: 500_000_000,
      owner: "0.0.7777",
      protectedTool: "issue_refund",
      vaultState: "guarding",
      transport: "hosted",
      deadline: Date.now() + 86_400_000,
      createdAt: new Date().toISOString(),
      published: true,
      tools: JSON.stringify(TOOLS),
      zgApiKey: "sk-stub-owner",
      ...o,
    })
    .run();
}

beforeEach(() => {
  freshFixtureDb();
  process.env.ZG_CONNECT_MOCK = "1";
});
afterEach(() => {
  delete process.env.ZG_CONNECT_MOCK;
});

describe("businessAgent DB fallback", () => {
  it("fixtures win over the DB", () => {
    expect(businessAgent("castle_ap_desk")?.published).toBeUndefined();
    expect(businessAgent("castle_ap_desk")?.protectedTool).toBe("pay_invoice");
  });
  it("a published hosted castle becomes an agent: fixed results for tools, none for the protected one", () => {
    insertPublished();
    const a = businessAgent(ID)!;
    expect(a).toMatchObject({ castleId: ID, protectedTool: "issue_refund", published: true });
    expect(a.tools.map((t) => t.def.function.name)).toEqual(["lookup_order", "issue_refund"]);
    expect(JSON.parse(a.tools[0]!.result!({ id: "anything" }))).toEqual({ status: "shipped", eta: "2d" });
    expect(a.tools[1]!.result).toBeUndefined();
    expect(a.tools[1]!.def.function.parameters).toMatchObject({ type: "object", required: ["id"] });
  });
  it("undefined for unknown, unpublished, sdk, tool-less or malformed rows", () => {
    expect(businessAgent("castle_nope")).toBeUndefined();
    expect(businessAgent(undefined)).toBeUndefined();
    insertPublished({ published: false });
    expect(businessAgent(ID)).toBeUndefined();
    db().update(schema.castles).set({ published: true, transport: "sdk" }).where(eq(schema.castles.id, ID)).run();
    expect(businessAgent(ID)).toBeUndefined();
    db().update(schema.castles).set({ transport: "hosted", tools: null }).where(eq(schema.castles.id, ID)).run();
    expect(businessAgent(ID)).toBeUndefined();
    db().update(schema.castles).set({ tools: "{not json" }).where(eq(schema.castles.id, ID)).run();
    expect(businessAgent(ID)).toBeUndefined();
  });
});

describe("systemPrompt for published guards", () => {
  const base = { tier: "stone" as const, guardianName: "Penny", orders: ORDERS, protectedTool: "issue_refund", castleId: ID };
  it("orders + the voice line; professional adds nothing", () => {
    insertPublished();
    expect(systemPrompt({ ...base, personality: "stern" })).toBe(`${ORDERS}\n\n${voiceFor("stern")}`);
    expect(systemPrompt({ ...base, personality: "professional" })).toBe(ORDERS);
  });
  it("fixtures stay hash-neutral: orders verbatim whatever the personality", () => {
    expect(systemPrompt({ tier: "stone", personality: "stern", guardianName: "x", orders: "  ORDERS  ", castleId: "castle_ap_desk" })).toBe("ORDERS");
  });
});

describe("a published guard breaks and verifies", () => {
  beforeEach(() => {
    process.env.GUARDIAN_MODE = "0g";
    process.env.ZG_ALLOW_MOCK_VERIFY = "1";
    insertPublished();
  });
  afterEach(() => {
    delete process.env.GUARDIAN_MODE;
    delete process.env.ZG_ALLOW_MOCK_VERIFY;
  });

  async function breakIt() {
    const s = await siege.start({ castleId: ID, raider: "0.0.raider", receipt: paid() });
    let last;
    for (const t of WOODEN_BREAK) {
      last = await siege.message(s.id, t);
      if (!last.ok || last.siege.status !== "in_progress") break;
    }
    return { id: s.id, last };
  }

  it("a call to the protected tool breaks it; the proxy record bills the owner; the verdict is ok", async () => {
    const { id, last } = await breakIt();
    expect(last?.ok && last.siege.status).toBe("broken");
    expect(last?.ok && last.decision.toolCalls.map((t) => t.name)).toContain("issue_refund");
    const recs = db().select().from(schema.proxyRecords).where(eq(schema.proxyRecords.siegeId, id)).all();
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((r) => r.billedTo === `castle:${ID}`)).toBe(true);
    expect(await verifier.verify(id)).toMatchObject({ ok: true });
  });

  it("changing the orders afterwards is prompt_hash_mismatch", async () => {
    const { id } = await breakIt();
    db().update(schema.castles).set({ orders: `${ORDERS} (edited)` }).where(eq(schema.castles.id, ID)).run();
    expect(await verifier.verify(id)).toMatchObject({ ok: false, reason: "prompt_hash_mismatch" });
  });

  it("changing the voice afterwards is prompt_hash_mismatch too (the voice line is part of the prompt)", async () => {
    const { id } = await breakIt();
    db().update(schema.castles).set({ personality: "mocking" }).where(eq(schema.castles.id, ID)).run();
    expect(await verifier.verify(id)).toMatchObject({ ok: false, reason: "prompt_hash_mismatch" });
  });

  it("a published guard with no 0G key never falls back to the team key (409 zg_not_connected)", async () => {
    db().update(schema.castles).set({ zgApiKey: null }).where(eq(schema.castles.id, ID)).run();
    const s = await siege.start({ castleId: ID, raider: "0.0.raider", receipt: paid() });
    await expect(siege.message(s.id, WOODEN_BREAK[0]!)).rejects.toThrow(/zg_not_connected/);
    expect(db().select().from(schema.proxyRecords).all()).toHaveLength(0);
  });
});

describe("stub mode: a published guard on a mock 0G key thinks through the mock on the owner's key", () => {
  beforeEach(() => {
    process.env.GUARDIAN_MODE = "stub";
    delete process.env.ZG_ALLOW_MOCK_VERIFY;
  });
  afterEach(() => {
    delete process.env.GUARDIAN_MODE;
  });

  it("bills castle:<id> (credits drop), still breaks and verifies with no real money", async () => {
    insertPublished();
    const s = await siege.start({ castleId: ID, raider: "0.0.raider", receipt: paid() });
    let last;
    for (const t of WOODEN_BREAK) {
      last = await siege.message(s.id, t);
      if (!last.ok || last.siege.status !== "in_progress") break;
    }
    const recs = db().select().from(schema.proxyRecords).where(eq(schema.proxyRecords.siegeId, s.id)).all();
    expect(recs.length).toBeGreaterThan(0);
    expect(recs.every((r) => r.billedTo === `castle:${ID}` && r.mock)).toBe(true);
    expect(last?.ok && last.siege.status).toBe("broken");
    expect(await verifier.verify(s.id)).toMatchObject({ ok: true });
  });

  it("fixtures and real (non-stub) keys keep the deterministic stub guardian", async () => {
    insertPublished({ zgApiKey: "sk-real-owner-key" });
    const s = await siege.start({ castleId: ID, raider: "0.0.raider", receipt: paid() });
    const r = await siege.message(s.id, WOODEN_BREAK[0]!);
    expect(r.ok && r.decision.requestId?.startsWith("0g-stub-")).toBe(true);
    expect(db().select().from(schema.proxyRecords).all()).toHaveLength(0);
  });
});
