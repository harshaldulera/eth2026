import { beforeEach, describe, expect, it } from "vitest";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { createIntent, onDepositConfirmed, resetDepositHandlers } from "@/lib/pay/deposits";
import { GET } from "./route";

const call = (id: string) => GET(new Request(`http://localhost:3000/api/deposits/${id}`), { params: Promise.resolve({ id }) });

beforeEach(() => {
  freshFixtureDb();
  resetDepositHandlers();
});

describe("GET /api/deposits/[id]", () => {
  it("returns the public status of a funded stub intent", async () => {
    onDepositConfirmed("vault", async () => {});
    const c = await createIntent({ kind: "vault", refId: "castle-9", amountTinybar: 250_000_000 });
    const res = await call(c.intentId);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const b = await res.json();
    expect(b).toMatchObject({
      intentId: c.intentId,
      kind: "vault",
      state: "funded",
      received: "250000000",
      requested: "250000000",
      deposit: { to: "0.0.stub-arena", memo: `siege:${c.code}`, amount: "250000000" },
    });
    // nothing about the owning object or counted txs leaks
    expect(JSON.stringify(b)).not.toMatch(/castle-9|refId|txs|stub:0/);
  });

  it("404 for an unknown id", async () => {
    const res = await call("nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "deposit_not_found" });
  });
});
