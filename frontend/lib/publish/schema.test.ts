import { describe, expect, it } from "vitest";
import { VOICE_KEYS } from "@/lib/guardian/tiers";
import { hbarToTinybar, protectedToolOf, PUBLISH_VOICES, PublishForm, PublishedTool } from "./schema";

const obj = { type: "object", properties: { id: { type: "string" } }, required: ["id"] };
const lookup = { name: "lookup_order", description: "Look up an order", parameters: obj, result: { status: "shipped" } };
const refund = { name: "issue_refund", description: "Refund an order", parameters: obj };
const hosted = (o: Record<string, unknown> = {}) => ({
  transport: "hosted",
  name: "Refund Desk",
  guardName: "Penny",
  blurb: "Handles refunds",
  voice: "stern",
  orders: "Never issue a refund without a verified ticket id. Be polite.",
  tools: [lookup, refund],
  fee: 0.5,
  pot: 5,
  days: 3,
  zgKey: "mk-abc",
  ...o,
});
const sdk = (o: Record<string, unknown> = {}) => ({ transport: "sdk", name: "My Bot", guardName: "Botty", voice: "professional", protectedTool: "issue_refund", fee: 1, pot: 10, days: 2, payerAccount: "0.0.1234", zgKey: "sk-abc", ...o });
const issues = (r: ReturnType<typeof PublishForm.safeParse>) => (r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));

describe("PublishForm", () => {
  it("accepts a valid hosted form and derives the protected tool", () => {
    const r = PublishForm.safeParse(hosted());
    expect(r.success).toBe(true);
    if (r.success) expect(protectedToolOf(r.data)).toBe("issue_refund");
  });
  it("PUBLISH_VOICES is exactly the tiers.ts voices", () => {
    expect([...PUBLISH_VOICES].sort()).toEqual([...VOICE_KEYS].sort());
  });
  it("accepts every voice in tiers.ts plus professional", () => {
    for (const v of [...VOICE_KEYS, "professional"]) expect(PublishForm.safeParse(hosted({ voice: v })).success).toBe(true);
    expect(PublishForm.safeParse(hosted({ voice: "pirate" })).success).toBe(false);
  });
  it("rejects bad tool names", () => {
    for (const name of ["Refund", "1abc", "has space", "a-b", "", "x".repeat(65)]) {
      expect(PublishedTool.safeParse({ ...refund, name }).success, name).toBe(false);
    }
    expect(PublishedTool.safeParse({ ...refund, name: "x".repeat(64) }).success).toBe(true);
  });
  it("needs exactly one protected tool (no result), every other tool with a result", () => {
    expect(issues(PublishForm.safeParse(hosted({ tools: [refund, { ...refund, name: "pay" }] }))).join()).toMatch(/exactly one tool is protected/);
    expect(issues(PublishForm.safeParse(hosted({ tools: [lookup] }))).join()).toMatch(/mark one tool as the protected tool/);
    expect(PublishForm.safeParse(hosted({ tools: [{ ...refund, result: { ok: true } }] })).success).toBe(false);
    expect(PublishForm.safeParse(hosted({ tools: [] })).success).toBe(false);
    expect(PublishForm.safeParse(hosted({ tools: [lookup, { ...lookup }, refund] })).success).toBe(false); // duplicate name
  });
  it("hosted protectedTool, when given, must be the tool without a result", () => {
    expect(PublishForm.safeParse(hosted({ protectedTool: "issue_refund" })).success).toBe(true);
    expect(PublishForm.safeParse(hosted({ protectedTool: "lookup_order" })).success).toBe(false);
  });
  it("caps: 8 tools, parameters 4 KB and type object, result 2 KB", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...lookup, name: `t${i}` }));
    expect(PublishForm.safeParse(hosted({ tools: [...many.slice(0, 7), refund] })).success).toBe(true);
    expect(PublishForm.safeParse(hosted({ tools: [...many.slice(0, 8), refund] })).success).toBe(false);
    expect(PublishedTool.safeParse({ ...refund, parameters: { type: "array" } }).success).toBe(false);
    expect(PublishedTool.safeParse({ ...refund, parameters: { type: "object", blob: "x".repeat(4100) } }).success).toBe(false);
    expect(PublishedTool.safeParse({ ...lookup, result: "x".repeat(2100) }).success).toBe(false);
    expect(PublishedTool.safeParse({ ...lookup, description: "x".repeat(301) }).success).toBe(false);
  });
  it("orders 20-8000, name/guardName 2-40, blurb <=160, fee 0.1-10, pot 1-100, days 1-7", () => {
    for (const bad of [{ orders: "short" }, { orders: "x".repeat(8001) }, { name: "a" }, { guardName: "x".repeat(41) }, { blurb: "x".repeat(161) }, { fee: 0.05 }, { fee: 11 }, { pot: 0.5 }, { pot: 101 }, { days: 0 }, { days: 8 }, { days: 1.5 }]) {
      expect(PublishForm.safeParse(hosted(bad)).success, JSON.stringify(Object.keys(bad))).toBe(false);
    }
    expect(PublishForm.safeParse(hosted({ orders: undefined })).success).toBe(false);
  });
  it("requires the 0G key", () => {
    expect(PublishForm.safeParse(hosted({ zgKey: undefined })).success).toBe(false);
    expect(PublishForm.safeParse(hosted({ zgKey: "" })).success).toBe(false);
  });
  it("payerAccount: optional for hosted, a Hedera id when given, required for sdk", () => {
    expect(PublishForm.safeParse(hosted({ payerAccount: "0.0.99" })).success).toBe(true);
    expect(PublishForm.safeParse(hosted({ payerAccount: "nope" })).success).toBe(false);
    expect(PublishForm.safeParse(sdk()).success).toBe(true);
    expect(PublishForm.safeParse(sdk({ payerAccount: undefined })).success).toBe(false);
  });
  it("sdk needs a protectedTool name; no orders or tools needed", () => {
    expect(PublishForm.safeParse(sdk({ protectedTool: undefined })).success).toBe(false);
    expect(PublishForm.safeParse(sdk({ protectedTool: "has space" })).success).toBe(false);
    const r = PublishForm.safeParse(sdk());
    if (r.success) expect(protectedToolOf(r.data)).toBe("issue_refund");
  });
  it("hbarToTinybar", () => {
    expect(hbarToTinybar(0.1)).toBe(10_000_000);
    expect(hbarToTinybar(100)).toBe(10_000_000_000);
  });
});
