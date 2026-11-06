import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DOC_SECTIONS } from "./content";
import { docsMarkdown } from "./markdown";

const text = JSON.stringify(DOC_SECTIONS);

describe("developer docs", () => {
  it("docs/API.md is the generated copy of the page content (run: npx tsx scripts/gen-api-md.ts)", () => {
    const file = path.resolve(process.cwd(), "../docs/API.md");
    expect(readFileSync(file, "utf8")).toBe(docsMarkdown());
  });

  it("covers every journey and the J5 contract", () => {
    for (const id of ["j1", "j2", "j3", "j5", "claims"]) expect(DOC_SECTIONS.some((s) => s.id === id), id).toBe(true);
    for (const needle of [
      "PAYMENT-REQUIRED", "PAYMENT-SIGNATURE", "PAYMENT-RESPONSE", "x-siege-turn-token", "x-siege-operator-key",
      "402", "turn_token_required", "recon_requires_visitor", "not_guarding", "castle_not_open", "payment_already_used",
      "no_turns_left", "free_used", "payment_pending", "guardian_unavailable", "createGuard", "guard.serve", "orders_changed",
      "30 seconds", "/api/operators", "custodies",
    ]) {
      expect(text, needle).toContain(needle);
    }
  });

  it("never prints a real key or secret", () => {
    expect(docsMarkdown()).not.toMatch(/\b(ok|rk|gk|vk)_[A-Za-z0-9_-]{16,}/);
    expect(docsMarkdown()).not.toMatch(/0x[0-9a-f]{40,}/i);
  });
});
