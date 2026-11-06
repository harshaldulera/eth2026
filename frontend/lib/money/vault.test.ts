import { describe, expect, it } from "vitest";
import { ApiError, describeError, isNotGuarding } from "@/lib/api/client";
import { closeReasonText, notTakingSiegesReason, vaultStateOf, voidCause } from "./vault";

describe("vault-state UI helpers", () => {
  it("falls back to castle status when vaultState is missing", () => {
    expect(vaultStateOf({ status: "open" })).toBe("guarding");
    expect(vaultStateOf({ status: "broken" })).toBe("broken");
    expect(vaultStateOf({ status: "open", vaultState: "dormant" })).toBe("dormant");
  });

  it("explains why a castle is not taking sieges", () => {
    expect(notTakingSiegesReason("guarding")).toBeNull();
    expect(notTakingSiegesReason("dormant")).toMatch(/offline/);
    expect(notTakingSiegesReason("funded")).toMatch(/set up/);
    expect(closeReasonText("orders_changed")).toBe("the guardian's orders changed");
    expect(closeReasonText("owner_closed")).toBe("closed by the Castellan");
  });

  it("classifies void reasons", () => {
    expect(voidCause("guardian_dormant")).toBe("offline");
    expect(voidCause("castle_closed")).toBe("closed");
    expect(voidCause("orders_changed")).toBe("closed");
    expect(voidCause("castle_closed_owner_closed")).toBe("closed");
    expect(voidCause("castle_closed_orders_changed")).toBe("closed");
    expect(voidCause("vault_expired")).toBe("closed");
    expect(voidCause("castle_broken")).toBe("other");
    expect(voidCause("vault_not_open")).toBe("other");
    expect(voidCause("something_new", "dormant")).toBe("offline");
    expect(voidCause(undefined, "guarding")).toBe("other");
  });

  it("turns a 409 not_guarding into a friendly message", () => {
    const e = new ApiError(409, { error: "not_guarding", vaultState: "dormant" });
    expect(isNotGuarding(e)).toBe(true);
    expect(e.notGuarding?.vaultState).toBe("dormant");
    expect(describeError(e)).toMatch(/offline/);
    expect(isNotGuarding(new ApiError(409, { error: "ended" }))).toBe(false);
    expect(describeError(new ApiError(409, { error: "not_guarding" }))).toMatch(/isn't taking sieges/);
  });
});
