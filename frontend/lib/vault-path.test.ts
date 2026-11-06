import { describe, expect, it } from "vitest";
import { castleIdFromSlug, vaultPath } from "./vault-path";

describe("vault paths", () => {
  it("drops the legacy prefix in links and restores it from either URL form", () => {
    expect(vaultPath("castle_splinter_gate")).toBe("/vault/splinter_gate");
    expect(vaultPath("castle_5b679d677c6247a1")).toBe("/vault/5b679d677c6247a1");
    expect(castleIdFromSlug("splinter_gate")).toBe("castle_splinter_gate");
    expect(castleIdFromSlug("castle_splinter_gate")).toBe("castle_splinter_gate");
  });
});
