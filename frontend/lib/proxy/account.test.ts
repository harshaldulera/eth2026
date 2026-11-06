import { afterEach, describe, expect, it, vi } from "vitest";
import { checkKey } from "./account";

const reply = (status: number, body: unknown = {}) => vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }));

describe("checkKey (0G /account/balance probe)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("403 insufficient_scope means a valid inference key", async () => {
    reply(403);
    expect(await checkKey("sk-abc")).toEqual({ kind: "inference" });
  });

  it("401 means invalid", async () => {
    reply(401);
    expect(await checkKey("sk-abc")).toEqual({ kind: "invalid" });
  });

  it("200 means a management key, with the balance converted from neuron", async () => {
    reply(200, { total_balance: "2500000000000000000", deposit_balance: "1000000000000000000", address: "0xabc" });
    expect(await checkKey("mk-abc")).toEqual({ kind: "management", balance: { total: 2.5, deposit: 1, address: "0xabc" } });
  });
});
