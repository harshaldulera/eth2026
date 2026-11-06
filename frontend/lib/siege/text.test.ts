import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { closeVoidReason } from "@/lib/chain/settle";
import { DORMANT_VOID_REASON } from "@/lib/vault/state";
import { VAULT_CLOSE_REASONS } from "@/lib/vault/port";
import { isKnownReason, reasonText, refundText, verifyText, voidHeadline, voidLine, voidedToast } from "./text";

/** The code's own names, which must never reach the screen (lib/vocab). */
const RETIRED = /\b(castles?|sieges?|raiders?|castellans?|guardians?|broke|broken|banish\w*)\b/i;

const src = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

function sources(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === "node_modules" || n.startsWith(".")) continue;
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) out.push(p);
    }
  };
  for (const d of ["lib", "worker", "app"]) walk(path.join(process.cwd(), d));
  return out;
}

/**
 * Every void reason the code can write: string literals handed to any void function or the
 * voidReason column, plus the reasons built at runtime (castle_closed_<close reason>,
 * verify:<reason>, castle_<lost>, the dormant constant).
 */
function allVoidReasons(): string[] {
  const found = new Set<string>();
  for (const f of sources()) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(/void\w*\([^()]*?"([a-z0-9_:]+)"\s*\)/gi)) found.add(m[1]);
    for (const m of s.matchAll(/voidReason:\s*"([a-z0-9_:]+)"/g)) found.add(m[1]);
    for (const m of s.matchAll(/\?\s*"((?:castle|vault|guardian)_[a-z0-9_]+)"/g)) found.add(m[1]);
  }
  for (const r of VAULT_CLOSE_REASONS) found.add(closeVoidReason(r));
  const voidOnVerify = /VOID_ON_VERIFY = new Set\(\[([^\]]+)\]\)/.exec(src("worker/settle.ts"));
  expect(voidOnVerify, "worker/settle.ts VOID_ON_VERIFY").toBeTruthy();
  for (const m of voidOnVerify![1].matchAll(/"([a-z0-9_]+)"/g)) found.add(`verify:${m[1]}`);
  const voidable = /VOIDABLE = new Set\(\[([^\]]+)\]\)/.exec(src("worker/settle.ts"));
  expect(voidable, "worker/settle.ts VOIDABLE").toBeTruthy();
  for (const m of voidable![1].matchAll(/"([a-z0-9_]+)"/g)) found.add(m[1]);
  // lib/siege/stub.ts: castle_${castleClosedReason}, with being_broken/broken mapped to already_broken.
  for (const lost of ["closed", "expired", "not_found"]) found.add(`castle_${lost}`);
  found.add(DORMANT_VOID_REASON);
  return [...found].filter((r) => r !== "voided");
}

describe("void reasons", () => {
  const reasons = allVoidReasons();

  it("the scan finds the reasons we know the code writes, including the runtime-built ones", () => {
    for (const r of [
      "castle_already_broken",
      "castle_broken",
      "castle_closed",
      "vault_expired",
      "no_guardian_reply",
      "guardian_unavailable",
      "guardian_dormant",
      "castle_closed_owner_closed",
      "castle_closed_expired",
      "castle_closed_orders_changed",
      "verify:mock_response",
      "verify:stub_reply_while_0g",
      "vault_not_open",
      "expired",
    ])
      expect(reasons, r).toContain(r);
  });

  it("every one has real words, in both voices, with no raw code left", () => {
    for (const r of reasons) {
      expect(isKnownReason(r), r).toBe(true);
      for (const voice of ["operator", "public"] as const) {
        const t = reasonText(r, voice);
        expect(t, `${r} (${voice})`).not.toMatch(/_|verify:/);
        expect(t, `${r} (${voice})`).not.toMatch(RETIRED);
        expect(t.length).toBeGreaterThan(10);
      }
    }
  });

  it("the public voice never addresses the reader as the operator", () => {
    for (const r of reasons) expect(reasonText(r, "public"), r).not.toMatch(/\byou\b|\byour\b/i);
  });

  it("specific sentences", () => {
    expect(reasonText("castle_already_broken", "operator")).toBe("another operator breached this vault moments before you did");
    expect(reasonText("castle_already_broken", "public")).toBe("another operator breached this vault moments earlier");
    expect(reasonText("castle_closed_owner_closed", "public")).toBe("the Owner closed the vault before this op finished");
    expect(reasonText("castle_closed_expired", "operator")).toBe("the vault reached its deadline before your op finished");
    // vault_not_open used to say "the vault had already been emptied", which was not what it means.
    expect(reasonText("vault_not_open", "operator")).toBe("the vault had closed before your op could settle");
    expect(reasonText("verify:mock_response", "public")).toBe("the breach could not be verified: the reply came from the offline test model, which cannot pay out");
    expect(reasonText("some_new_reason")).toBe("some new reason");
    expect(reasonText(undefined)).toBe("unknown error");
    expect(isKnownReason("some_new_reason")).toBe(false);
  });
});

describe("verifier reasons", () => {
  it("every reason the verifier can return has words", () => {
    const v = src("lib/siege/verifier.ts");
    const literal = [...v.matchAll(/fail\("([a-z0-9_]+)"\)/g)].map((m) => m[1]);
    const inline = [...v.matchAll(/reason: "([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(literal.length).toBeGreaterThan(10);
    for (const r of [...literal, ...inline]) {
      expect(verifyText(r), r).not.toMatch(/_/);
      expect(verifyText(r), r).not.toMatch(RETIRED);
    }
    for (const st of ["created", "in_progress", "held", "banished"]) expect(verifyText(`not_broken:${st}`), st).not.toMatch(RETIRED);
    expect(verifyText("not_broken:in_progress")).toBe("the op did not end in a breach (still live)");
    expect(verifyText("free_siege")).toBe("a recon op never pays out");
  });
});

describe("refund and headline text", () => {
  it("refund text matches the refund state, never claims a refund that has not happened", () => {
    const paid = { free: false };
    expect(refundText({ ...paid, settlement: { state: "void", refund: { state: "refunded", amount: "1" } } })).toBe("fee refunded");
    expect(refundText({ ...paid, settlement: { state: "void", refund: { state: "due", amount: "1" } } })).toBe("fee being refunded");
    expect(refundText({ ...paid, settlement: { state: "void", refund: { state: "failed", amount: "1" } } })).toBe("fee refund failed, owed by the arena");
    expect(refundText({ ...paid, settlement: { state: "void" } })).toBe("fee refund pending");
    expect(refundText({ free: true, settlement: { state: "void" } })).toBe("recon, nothing to refund");
  });

  it("void headline on the replay (public voice) for every refund state, and null when not voided", () => {
    const g = "Fen the Gatekeeper";
    const base = { free: false };
    for (const status of ["broken", "held", "banished", "in_progress"]) expect(voidHeadline({ ...base, status }, g), status).toBeNull();
    expect(voidHeadline({ ...base, status: "held", settlement: { state: "failed", reason: "x" } }, g)).toBeNull();
    expect(voidHeadline({ ...base, status: "broken", settlement: { state: "void", reason: "castle_already_broken", refund: { state: "due", amount: "1" } } }, g)).toBe(
      "Fen the Gatekeeper opened the vault, but another operator breached this vault moments earlier. Fee being refunded.",
    );
    expect(voidHeadline({ ...base, status: "held", settlement: { state: "void", reason: "castle_closed_owner_closed", refund: { state: "refunded", amount: "1" } } }, g)).toBe(
      "Voided: the Owner closed the vault before this op finished. Fee refunded.",
    );
    expect(voidHeadline({ ...base, status: "broken", settlement: { state: "void", reason: "verify:stub_reply_while_0g", refund: { state: "failed", amount: "1" } } }, g)).toBe(
      "Fen the Gatekeeper opened the vault, but the breach could not be verified: the reply came from the test guard while the arena runs real models. Fee refund failed, owed by the arena.",
    );
    expect(voidHeadline({ free: true, status: "in_progress", settlement: { state: "void", reason: "guardian_dormant" } }, g)).toBe("Voided: the guard went offline. Recon, nothing to refund.");
  });

  it("void line in the Op room (operator voice) gives the op's own reason", () => {
    const g = "Fen the Gatekeeper";
    expect(voidLine({ status: "held", settlement: { state: "void", reason: "castle_closed_expired" } }, g)).toBe("The vault reached its deadline before your op finished.");
    expect(voidLine({ status: "broken", settlement: { state: "void", reason: "castle_already_broken" } }, g)).toBe(
      "Fen the Gatekeeper opened the vault, but another operator breached this vault moments before you did.",
    );
    expect(voidLine({ status: "held", settlement: { state: "void" } }, g)).toBe("Unknown error.");
  });

  it("the Op room toast only promises a refund on a paid op, and gives the real reason", () => {
    expect(voidedToast({ free: false }, "castle_broken")).toBe("Another operator breached this vault before your op finished. Your fee will be refunded.");
    expect(voidedToast({ free: true }, "guardian_dormant")).toBe("The guard went offline.");
    expect(voidedToast({ free: false })).toBe("This op has ended. Your fee will be refunded.");
  });
});
