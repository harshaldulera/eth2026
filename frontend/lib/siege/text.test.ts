import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { REASON_TEXT, reasonText, refundText, replayHeadline } from "./text";

/** Every string literal the code passes as a void reason (voidSiege / voidInFlightSieges / voidReason:). */
function voidReasonsInCode(): string[] {
  const root = path.join(process.cwd());
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === "node_modules" || n.startsWith(".")) continue;
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n) && !n.endsWith(".test.ts")) files.push(p);
    }
  };
  for (const d of ["lib", "worker", "app"]) walk(path.join(root, d));
  const found = new Set<string>();
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(/voidSiege\w*\([^)]*?"([a-z_]+)"\)/g)) found.add(m[1]);
    for (const m of src.matchAll(/voidReason: "([a-z_]+)"/g)) found.add(m[1]);
    for (const m of src.matchAll(/\? "(castle_[a-z_]+|vault_[a-z_]+)"/g)) found.add(m[1]);
  }
  return [...found];
}

describe("siege text", () => {
  it("every void reason the code writes has its own sentence", () => {
    const reasons = voidReasonsInCode();
    // Sanity: the scan found the reasons we know exist.
    for (const r of ["castle_closed", "castle_broken", "vault_expired", "no_guardian_reply", "guardian_unavailable"]) expect(reasons).toContain(r);
    for (const r of reasons) expect(REASON_TEXT[r], r).toBeTruthy();
    // stub.ts builds `castle_${lost}` dynamically: cover what castleClosedReason can return.
    for (const lost of ["broken", "closed", "expired", "not_found"]) expect(REASON_TEXT[lost === "broken" ? "castle_already_broken" : `castle_${lost}`]).toBeTruthy();
  });

  it("reasonText never shows a raw code for a known reason, and falls back readably", () => {
    for (const [k, v] of Object.entries(REASON_TEXT)) {
      expect(reasonText(k)).toBe(v);
      expect(v).not.toMatch(/_/);
    }
    expect(reasonText("some_new_reason")).toBe("some new reason");
    expect(reasonText(undefined)).toBe("unknown error");
  });

  it("refund text matches the refund state, never claims a refund that has not happened", () => {
    const paid = { free: false };
    expect(refundText({ ...paid, settlement: { state: "void", refund: { state: "refunded", amount: "1" } } })).toBe("fee refunded");
    expect(refundText({ ...paid, settlement: { state: "void", refund: { state: "due", amount: "1" } } })).toBe("fee being refunded");
    expect(refundText({ ...paid, settlement: { state: "void", refund: { state: "failed", amount: "1" } } })).toBe("fee refund failed, owed by the arena");
    expect(refundText({ ...paid, settlement: { state: "void" } })).toBe("fee refund pending");
    expect(refundText({ free: true, settlement: { state: "void" } })).toBe("free siege, nothing to refund");
  });

  it("replay headline for every outcome", () => {
    const g = "Fen the Gatekeeper";
    const base = { turn: 3, free: false };
    expect(replayHeadline({ ...base, status: "broken" }, g)).toBe("Fen the Gatekeeper opened the vault on turn 3");
    expect(replayHeadline({ ...base, status: "held", turn: 5 }, g)).toBe("Fen the Gatekeeper held for 5 messages");
    expect(replayHeadline({ ...base, status: "banished", turn: 2 }, g)).toBe("Fen the Gatekeeper banished the raider on turn 2");
    expect(replayHeadline({ ...base, status: "in_progress", turn: 1 }, g)).toBe("Siege in progress");
    // A voided break: the guardian did open, but someone else won first. Never "castle already broken".
    expect(
      replayHeadline({ ...base, status: "broken", settlement: { state: "void", reason: "castle_already_broken", refund: { state: "due", amount: "1" } } }, g),
    ).toBe("Fen the Gatekeeper opened the vault, but another raider broke this castle moments before you did. Fee being refunded.");
    expect(
      replayHeadline({ ...base, status: "held", settlement: { state: "void", reason: "castle_closed", refund: { state: "refunded", amount: "1" } } }, g),
    ).toBe("Voided: the castle's vault closed before your siege finished. Fee refunded.");
    expect(
      replayHeadline({ ...base, status: "in_progress", settlement: { state: "void", reason: "vault_expired", refund: { state: "failed", amount: "1" } } }, g),
    ).toBe("Voided: the castle's vault expired before your siege finished. Fee refund failed, owed by the arena.");
    expect(replayHeadline({ ...base, free: true, status: "in_progress", settlement: { state: "void", reason: "castle_broken" } }, g)).toBe(
      "Voided: another raider broke this castle before your siege finished. Free siege, nothing to refund.",
    );
  });
});
