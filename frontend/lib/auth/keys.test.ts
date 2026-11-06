import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashKey, isKeyOf, newKey, sameHash } from "./keys";

describe("lib/auth/keys", () => {
  it("newKey: prefix + 24 base64url chars, unique", () => {
    for (const p of ["ok", "rk", "gk", "vk"] as const) {
      const k = newKey(p);
      expect(k).toMatch(new RegExp(`^${p}_[A-Za-z0-9_-]{24}$`));
      expect(isKeyOf(p, k)).toBe(true);
    }
    const many = new Set(Array.from({ length: 200 }, () => newKey("ok")));
    expect(many.size).toBe(200);
  });

  it("hashKey is sha256 hex of the key", () => {
    const k = newKey("rk");
    expect(hashKey(k)).toBe(createHash("sha256").update(k).digest("hex"));
    expect(hashKey(k)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey(k)).not.toContain(k);
  });

  it("sameHash: equal only for identical hashes; false for missing or different lengths", () => {
    const h = hashKey("ok_abc");
    expect(sameHash(h, hashKey("ok_abc"))).toBe(true);
    expect(sameHash(h, hashKey("ok_abd"))).toBe(false);
    expect(sameHash(h, h.slice(1))).toBe(false);
    expect(sameHash(h, null)).toBe(false);
    expect(sameHash(undefined, h)).toBe(false);
    expect(sameHash("", "")).toBe(false);
  });

  it("isKeyOf checks the prefix and shape", () => {
    expect(isKeyOf("ok", newKey("rk"))).toBe(false);
    expect(isKeyOf("ok", "ok_short")).toBe(false);
    expect(isKeyOf("ok", "siege-demo-owner")).toBe(false);
    expect(isKeyOf("ok", undefined)).toBe(false);
    expect(isKeyOf("ok", `ok_${"a".repeat(200)}`)).toBe(false);
  });
});
