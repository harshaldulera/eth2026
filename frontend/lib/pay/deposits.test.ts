import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import type { AccountTransfer } from "@/lib/chain/mirror";
import {
  LATE_GRACE_MS,
  createIntent,
  expireIntents,
  getIntent,
  intentStatus,
  matchDeposits,
  newCode,
  onDepositConfirmed,
  resetDepositHandlers,
  retryFailed,
  settleIntent,
  type DepositIntent,
} from "./deposits";

const T0 = Date.parse("2026-11-01T10:00:00Z");
const ts = (ms: number) => `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1e6).padStart(9, "0")}`;

const intent = (o: Partial<DepositIntent> = {}): DepositIntent => ({
  id: "i1",
  kind: "vault",
  refId: "castle-1",
  code: "abcd2345",
  memo: "siege:abcd2345",
  amountTinybar: 100,
  payerFilter: null,
  state: "awaiting",
  receivedTinybar: 0,
  txs: "[]",
  payer: null,
  note: null,
  attempts: 0,
  error: null,
  createdAt: new Date(T0).toISOString(),
  expiresAt: new Date(T0 + 45 * 60_000).toISOString(),
  fundedAt: null,
  claimedAt: null,
  step: null,
  ...o,
});
const tr = (o: Partial<AccountTransfer> = {}): AccountTransfer => ({
  txId: "0.0.1-1-1",
  payer: "0.0.777",
  memo: "siege:abcd2345",
  amountToAccount: "100",
  consensusTimestamp: ts(T0 + 60_000),
  ...o,
});

describe("matchDeposits", () => {
  it("matches the exact memo and funds when the amount is met", () => {
    const [m] = matchDeposits([intent()], [tr()]);
    expect(m).toMatchObject({ intentId: "i1", received: 100, enough: true, late: false, payer: "0.0.777", txs: ["0.0.1-1-1"] });
  });
  it("ignores case and surrounding spaces in the memo", () => {
    expect(matchDeposits([intent()], [tr({ memo: "  SIEGE:ABCD2345 " })])).toHaveLength(1);
  });
  it("ignores a wrong or missing memo", () => {
    expect(matchDeposits([intent()], [tr({ memo: "siege:zzzzzzzz" }), tr({ txId: "x", memo: "" }), tr({ txId: "y", memo: "siege:abcd2345x" })])).toEqual([]);
  });
  it("respects the payer filter", () => {
    const i = intent({ payerFilter: "0.0.555" });
    expect(matchDeposits([i], [tr()])).toEqual([]);
    expect(matchDeposits([i], [tr({ payer: "0.0.555" })])).toHaveLength(1);
  });
  it("sums two partial payments: underpaid, then enough", () => {
    const a = tr({ txId: "a", amountToAccount: "40" });
    const b = tr({ txId: "b", amountToAccount: "60" });
    const [m1] = matchDeposits([intent()], [a]);
    expect(m1).toMatchObject({ received: 40, enough: false });
    const [m2] = matchDeposits([intent()], [a, b]);
    expect(m2).toMatchObject({ received: 100, enough: true });
    // a later pass with the first already counted adds only the new tx
    const [m3] = matchDeposits([intent({ state: "underpaid", receivedTinybar: 40, txs: JSON.stringify(["a"]) })], [a, b]);
    expect(m3).toMatchObject({ received: 100, enough: true, txs: ["a", "b"] });
  });
  it("counts a tx id once, within a list and across passes", () => {
    const [m] = matchDeposits([intent({ amountTinybar: 200 })], [tr(), tr()]);
    expect(m).toMatchObject({ received: 100, enough: false });
    expect(matchDeposits([intent({ state: "underpaid", receivedTinybar: 100, txs: JSON.stringify(["0.0.1-1-1"]) })], [tr()])).toEqual([]);
  });
  it("skips funded, funding and failed intents", () => {
    for (const state of ["funded", "funding", "failed"] as const) expect(matchDeposits([intent({ state })], [tr()])).toEqual([]);
  });
  it("funds late within 24 h after expiry (late flag), but not after", () => {
    const exp = T0 + 45 * 60_000;
    const [m] = matchDeposits([intent({ state: "expired" })], [tr({ consensusTimestamp: ts(exp + 60_000) })]);
    expect(m).toMatchObject({ enough: true, late: true });
    expect(matchDeposits([intent({ state: "expired" })], [tr({ consensusTimestamp: ts(exp + LATE_GRACE_MS + 1000) })])).toEqual([]);
  });
  it("matches several intents independently", () => {
    const out = matchDeposits(
      [intent(), intent({ id: "i2", code: "mmmm2222", memo: "siege:mmmm2222" })],
      [tr(), tr({ txId: "q", memo: "siege:mmmm2222" })],
    );
    expect(out.map((m) => m.intentId)).toEqual(["i1", "i2"]);
  });
});

describe("codes", () => {
  it("are 8 chars from the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) expect(newCode()).toMatch(/^[abcdefghjkmnpqrstuvwxyz23456789]{8}$/);
  });
});

function insert(o: Partial<DepositIntent> = {}) {
  const i = intent(o);
  db().insert(schema.depositIntents).values(i).run();
  return i;
}
const full = (id = "i1") => ({ intentId: id, received: 100, txs: ["t1"], payer: "0.0.777", enough: true, late: false });

describe("settleIntent", () => {
  beforeEach(() => {
    freshFixtureDb();
    resetDepositHandlers();
  });

  it("claims once: the second call is a no-op and the handler ran once", async () => {
    const h = vi.fn(async () => {});
    onDepositConfirmed("vault", h);
    insert();
    const [a, b] = await Promise.all([settleIntent("i1", full()), settleIntent("i1", full())]);
    expect([a, b].sort()).toEqual(["funded", "funding"]);
    expect(h).toHaveBeenCalledTimes(1);
    expect(await settleIntent("i1", full())).toBe("funded");
    expect(h).toHaveBeenCalledTimes(1);
    expect(getIntent("i1")).toMatchObject({ state: "funded", receivedTinybar: 100, payer: "0.0.777" });
    expect(getIntent("i1")!.fundedAt).toBeTruthy();
  });

  it("records underpaid with the received amount", async () => {
    insert();
    expect(await settleIntent("i1", { ...full(), received: 40, enough: false })).toBe("underpaid");
    expect(getIntent("i1")).toMatchObject({ state: "underpaid", receivedTinybar: 40 });
  });

  it("a handler failure marks failed (+error, attempts) and retryFailed re-runs it", async () => {
    let n = 0;
    onDepositConfirmed("vault", async () => {
      if (++n === 1) throw new Error("boom");
    });
    insert();
    expect(await settleIntent("i1", full())).toBe("failed");
    expect(getIntent("i1")).toMatchObject({ state: "failed", error: "boom", attempts: 1 });
    expect(await retryFailed("i1")).toBe("funded");
    expect(await retryFailed("i1")).toBeNull();
    expect(n).toBe(2);
  });

  it("without a registered handler the intent fails (so a retry can fund it later)", async () => {
    insert();
    expect(await settleIntent("i1", full())).toBe("failed");
    expect(getIntent("i1")!.error).toContain("no_handler");
  });

  it("a late match funds an expired intent and notes it", async () => {
    onDepositConfirmed("vault", async () => {});
    insert({ state: "expired" });
    expect(await settleIntent("i1", { ...full(), late: true })).toBe("funded");
    expect(getIntent("i1")!.note).toMatch(/late/);
  });

  it("expireIntents flips only open intents past their window", () => {
    insert({ id: "old", code: "aaaaaaaa", expiresAt: new Date(T0).toISOString() });
    insert({ id: "new", code: "bbbbbbbb", expiresAt: new Date(T0 + 3_600_000).toISOString() });
    insert({ id: "done", code: "cccccccc", state: "funded", expiresAt: new Date(T0).toISOString() });
    expect(expireIntents(T0 + 1000)).toBe(1);
    expect(getIntent("old")!.state).toBe("expired");
    expect(getIntent("new")!.state).toBe("awaiting");
    expect(getIntent("done")!.state).toBe("funded");
  });

  it("intentStatus shows expired as soon as the window passes and redacts keys in errors", () => {
    insert({ id: "e", code: "eeeeeeee", memo: "siege:eeeeeeee", state: "failed", error: "bad key ok_abcdefghijklmnopqrstuvwx here" });
    const s = intentStatus("e")!;
    expect(s.error).not.toContain("ok_abcdef");
    insert();
    expect(intentStatus("i1", T0 + 46 * 60_000)!.state).toBe("expired");
    expect(intentStatus("i1", T0)!.state).toBe("awaiting");
    expect(intentStatus("nope")).toBeNull();
  });
});

describe("createIntent (stub)", () => {
  beforeEach(() => {
    freshFixtureDb();
    resetDepositHandlers();
  });

  it("confirms inline: handler runs before it returns, final state funded", async () => {
    const seen: DepositIntent[] = [];
    onDepositConfirmed("unit", async (i) => void seen.push(i));
    const r = await createIntent({ kind: "unit", refId: "draft-1", amountTinybar: 500_000_000n });
    expect(r).toMatchObject({ state: "funded", amount: "500000000", to: "0.0.stub-arena" });
    expect(r.memo).toBe(`siege:${r.code}`);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ refId: "draft-1", payer: `0.0.stub-owner-${r.code}` });
    const row = getIntent(r.intentId)!;
    expect(JSON.parse(row.txs)).toHaveLength(1);
    expect(row.txs).toContain("stub:");
    expect(new Date(r.expiresAt).getTime()).toBeGreaterThan(Date.now() + 40 * 60_000);
  });

  it("returns failed when no handler is registered, then funds on retry", async () => {
    const r = await createIntent({ kind: "topup", refId: "a1", amountTinybar: 10 });
    expect(r.state).toBe("failed");
    onDepositConfirmed("topup", async () => {});
    expect(await retryFailed(r.intentId)).toBe("funded");
  });

  it("accepts vault-sdk and rejects non-positive amounts", async () => {
    onDepositConfirmed("vault-sdk", async () => {});
    expect((await createIntent({ kind: "vault-sdk", refId: "c", amountTinybar: 1, windowMin: 5 })).state).toBe("funded");
    await expect(createIntent({ kind: "vault", refId: "c", amountTinybar: 0 })).rejects.toThrow("invalid_amount");
  });

  it("each intent gets a unique code", async () => {
    onDepositConfirmed("vault", async () => {});
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) codes.add((await createIntent({ kind: "vault", refId: `c${i}`, amountTinybar: 1 })).code);
    expect(codes.size).toBe(20);
    expect(db().select().from(schema.depositIntents).where(eq(schema.depositIntents.kind, "vault")).all()).toHaveLength(20);
  });
});
