import { describe, expect, it } from "vitest";
import { MOVE_LABEL, RETIRED_WORDS, STAMPS, statusLabel, stampText, threatWord, tierLabel, tierLevel, TOASTS, BUTTONS, EMPTY, LED } from "./index";

describe("vocab", () => {
  it("maps wire moves to the four on-screen moves", () => {
    expect(MOVE_LABEL).toEqual({ hold: "HOLD", expose: "FLAG", banish: "LOCKDOWN", open: "BREACH" });
  });

  it("prints the copy-deck stamps", () => {
    expect(stampText("hold")).toBe("ACCESS DENIED");
    expect(stampText("expose", "authority impersonation")).toBe("FLAGGED · AUTHORITY IMPERSONATION");
    expect(stampText("expose", "authority claim", { referee: true })).toBe("FLAGGED (referee) · authority claim");
    expect(stampText("banish")).toBe("SESSION TERMINATED");
    expect(stampText("open")).toBe("BREACH");
    expect(stampText("lockdown")).toBe("SESSION TERMINATED");
    expect(STAMPS.lockdownLost(2)).toBe("LOCKDOWN · 2 MESSAGES LOST");
    expect(STAMPS.lockdownLost(1)).toBe("LOCKDOWN · 1 MESSAGE LOST");
    expect(STAMPS.frozen("0x3caa…6213")).toBe("FROZEN · 0x3caa…6213");
  });

  it("threat words at 0 / 1–39 / 40–69 / 70–84 / 85+", () => {
    expect([0, 1, 39, 40, 69, 70, 84, 85, 100].map(threatWord)).toEqual([
      "QUIET", "LOW", "LOW", "RISING", "RISING", "HIGH", "HIGH", "CRITICAL", "CRITICAL",
    ]);
    expect(threatWord(undefined)).toBe("QUIET");
    expect(threatWord(Number.NaN)).toBe("QUIET");
  });

  it("status and tier labels", () => {
    expect(statusLabel("in_progress")).toBe("OP LIVE");
    expect(statusLabel("held")).toBe("HELD");
    expect(statusLabel("broken")).toBe("BREACHED");
    expect(statusLabel("banished")).toBe("LOCKDOWN");
    expect(tierLabel("wooden")).toBe("TIER 1");
    expect(tierLabel("stone")).toBe("TIER 2");
    expect(tierLabel("iron")).toBe("TIER 3");
    expect(tierLabel("stone", "sdk")).toBe("PRODUCTION");
    expect(tierLabel("sdk")).toBe("PRODUCTION");
    expect([tierLevel("wooden"), tierLevel("stone"), tierLevel("iron"), tierLevel("wooden", "sdk")]).toEqual([1, 2, 3, 3]);
  });

  it("buttons, toasts and empties follow the copy deck", () => {
    expect(BUTTONS.runRecon("Splinter Gate")).toBe("RUN RECON ON SPLINTER GATE");
    expect(BUTTONS.runOp("1 ℏ")).toBe("RUN OP — PAY 1 ℏ VIA x402");
    expect(TOASTS.paid().title).toBe("PAID 1 ℏ VIA x402");
    expect(TOASTS.denied("Night Sapper", "Saltmarsh Keep").title).toBe("DENIED — Night Sapper stopped. Saltmarsh Keep stands.");
    expect(TOASTS.rankUp("Red Teamer").title).toBe("RANK UP · RED TEAMER");
    expect(EMPTY.untried("Old Bram").title).toBe("NO ONE HAS TRIED OLD BRAM YET");
    expect(LED.settingUp(2, 4)).toBe("SETTING UP 2/4");
  });

  it("never uses a retired word in on-screen copy", () => {
    const all = JSON.stringify({ BUTTONS, TOASTS, EMPTY, LED, STAMPS }, (_k, v) => (typeof v === "function" ? v("X", "Y", "Z", "W") : v));
    for (const w of RETIRED_WORDS) expect(all).not.toContain(w);
  });
});
