import { describe, expect, it } from "vitest";
import { stepsOf } from "./plug-in-agent";
import { PLUG_IN } from "@/lib/vocab";

const st = (c: Parameters<typeof stepsOf>[0]) => Object.fromEntries(stepsOf(c).steps.map((s) => [s.key, s.state]));

describe("plug-in strip", () => {
  it("waits for the agent", () => {
    expect(st({ vaultState: "created" })).toMatchObject({ connected: "active", selfCheck: "todo", guarding: "todo" });
  });
  it("walks self-check and smoke", () => {
    expect(st({ vaultState: "connected", sdk: { leaseLive: true, promptPinned: false } })).toMatchObject({ connected: "done", selfCheck: "active" });
    const c = { vaultState: "connected" as const, sdk: { leaseLive: true, promptPinned: true, selfCheckAt: "x", smokeHeld: 1 } };
    expect(st(c)).toMatchObject({ selfCheck: "done", smoke: "active" });
    expect(stepsOf(c).steps[2].label).toBe(PLUG_IN.steps.smoke(1));
  });
  it("verified asks for funding; guarding lights everything", () => {
    expect(st({ vaultState: "verified" })).toMatchObject({ smoke: "done", verified: "done", fund: "active", guarding: "todo" });
    expect(Object.values(st({ vaultState: "guarding" })).every((v) => v === "done")).toBe(true);
  });
  it("shows the failure on the right step", () => {
    const r = stepsOf({ vaultState: "connected", sdk: { leaseLive: true, promptPinned: true, selfCheckAt: "x", smoke: { ok: false, at: "x", reason: "smoke_failed_turn_2" } } });
    expect(r.steps[2].state).toBe("failed");
    expect(PLUG_IN.failure(r.failure)).toMatch(/turn 2/);
    const r2 = stepsOf({ vaultState: "connected", sdk: { leaseLive: true, promptPinned: false, smoke: { ok: false, at: "x", reason: "protected_tool_not_offered" } } });
    expect(r2.steps[1].state).toBe("failed");
  });
});
