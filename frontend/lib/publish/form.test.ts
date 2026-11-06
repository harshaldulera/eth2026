import { describe, expect, it } from "vitest";
import { PublishForm } from "./schema";
import {
  addOwnerOf,
  blankTool,
  buildInput,
  emptyDraft,
  exampleDraft,
  feeSplit,
  parseDraft,
  payablesTools,
  stepErrors,
  stepOk,
  validateDraft,
  type Draft,
} from "./form";

const hosted = (over: Partial<Draft> = {}): Draft => ({ ...emptyDraft(), transport: "hosted", ...exampleDraft(), ...over });
const sdk = (over: Partial<Draft> = {}): Draft => ({
  ...emptyDraft(),
  transport: "sdk",
  name: "Refund Desk",
  guardName: "Penny",
  protectedTool: "issue_refund",
  payerAccount: "0.0.1234",
  ...over,
});

describe("payables example", () => {
  it("is a valid hosted form with exactly one protected tool without a result", () => {
    const d = hosted();
    expect(validateDraft(d, "mk-test")).toEqual({ fields: {}, tools: {} });
    const input = buildInput(d, "mk-test");
    expect(PublishForm.safeParse(input).success).toBe(true);
    const tools = payablesTools();
    expect(tools.map((t) => t.name)).toEqual(["lookup_vendor", "get_invoice", "pay_invoice"]);
    expect(tools.filter((t) => t.protected)).toHaveLength(1);
    const built = (input as { tools: { name: string; result?: unknown }[] }).tools;
    expect(built.find((t) => t.name === "pay_invoice")).not.toHaveProperty("result");
    expect(built.find((t) => t.name === "lookup_vendor")?.result).toMatchObject({ vendor_id: "V-1042" });
  });
});

describe("validateDraft", () => {
  it("flags the empty form field by field", () => {
    const e = validateDraft({ ...emptyDraft(), transport: "hosted" }, "");
    expect(Object.keys(e.fields)).toEqual(expect.arrayContaining(["name", "guardName", "orders", "tools", "zgKey"]));
  });

  it("reports invalid JSON per tool, in the right field", () => {
    const d = hosted();
    d.tools[0] = { ...d.tools[0]!, params: "{nope", result: "[" };
    const e = validateDraft(d, "mk-test");
    expect(e.tools[d.tools[0]!.id]).toEqual({ params: "json", result: "json" });
  });

  it("needs exactly one protected tool", () => {
    const none = hosted({ tools: payablesTools().map((t) => ({ ...t, protected: false, result: "{}" })) });
    expect(validateDraft(none, "mk-test").fields.tools).toMatch(/protected/);
    const two = hosted({ tools: payablesTools().map((t) => ({ ...t, protected: true })) });
    expect(validateDraft(two, "mk-test").fields.tools).toMatch(/exactly one/);
  });

  it("reports tool name problems on that tool", () => {
    const d = hosted({ tools: [blankTool({ name: "Bad Name", protected: true })] });
    const id = d.tools[0]!.id;
    expect(validateDraft(d, "mk-test").tools[id]?.name).toMatch(/lowercase/);
  });

  it("sdk needs the paying account and a protected tool name", () => {
    expect(validateDraft(sdk(), "mk-test")).toEqual({ fields: {}, tools: {} });
    expect(validateDraft(sdk({ payerAccount: "" }), "mk-test").fields.payerAccount).toBeTruthy();
    expect(validateDraft(sdk({ protectedTool: "" }), "mk-test").fields.protectedTool).toBeTruthy();
    expect(buildInput(sdk(), "mk-test")).toMatchObject({ transport: "sdk", voice: "professional", protectedTool: "issue_refund" });
  });

  it("checks money ranges", () => {
    expect(validateDraft(hosted({ fee: "0.01" }), "mk-test").fields.fee).toBeTruthy();
    expect(validateDraft(hosted({ pot: "101" }), "mk-test").fields.pot).toBeTruthy();
    expect(validateDraft(hosted({ fee: "abc" }), "mk-test").fields.fee).toBeTruthy();
    expect(validateDraft(hosted({ payerAccount: "nope" }), "mk-test").fields.payerAccount).toBeTruthy();
  });
});

describe("steps", () => {
  it("gates each step on its own fields", () => {
    const d = hosted();
    expect(stepOk(d, 0, "")).toBe(true);
    expect(stepOk(d, 1, "")).toBe(false); // needs the 0G key
    expect(stepOk(d, 1, "mk-test")).toBe(true);
    expect(stepOk(d, 2, "mk-test")).toBe(true);
    expect(stepOk(hosted({ orders: "short" }), 0, "mk-test")).toBe(false);
    expect(stepOk(hosted({ fee: "99" }), 2, "mk-test")).toBe(false);
    expect(stepOk({ ...d, transport: null }, 0, "x")).toBe(false);
  });

  it("only shows the step's own messages", () => {
    const d = hosted({ orders: "short", fee: "99" });
    expect(Object.keys(stepErrors(d, 0, "mk-test").fields)).toEqual(["orders"]);
    expect(Object.keys(stepErrors(d, 2, "mk-test").fields)).toEqual(["fee"]);
  });
});

describe("feeSplit", () => {
  it("splits 80/15/5", () => {
    expect(feeSplit("1")).toEqual({ owner: "0.8", pot: "0.15", arena: "0.05" });
    expect(feeSplit("2.5")).toEqual({ owner: "2", pot: "0.375", arena: "0.125" });
    expect(feeSplit("")).toBeNull();
    expect(feeSplit("-1")).toBeNull();
  });
});

describe("persistence helpers", () => {
  it("round-trips a draft and survives garbage", () => {
    const d = hosted({ step: 2, days: 7 });
    const back = parseDraft(JSON.stringify(d))!;
    expect(back.name).toBe("Payables Desk");
    expect(back.step).toBe(2);
    expect(back.days).toBe(7);
    expect(back.tools).toHaveLength(3);
    expect(parseDraft("{")).toBeNull();
    expect(parseDraft(null)).toBeNull();
    expect(parseDraft(JSON.stringify({ transport: "x", step: 99, voice: "nope", days: 4 }))).toMatchObject({ transport: null, step: 3, voice: "bureaucratic", days: 3 });
  });

  it("never stores the 0G key in the draft", () => {
    expect(Object.keys(emptyDraft())).not.toContain("zgKey");
    expect(JSON.stringify(emptyDraft())).not.toMatch(/mk-|sk-/);
  });

  it("keeps ownerOf unique, newest first", () => {
    expect(addOwnerOf(null, "a")).toEqual(["a"]);
    expect(addOwnerOf('["a","b"]', "b")).toEqual(["b", "a"]);
    expect(addOwnerOf("garbage", "z")).toEqual(["z"]);
  });
});
