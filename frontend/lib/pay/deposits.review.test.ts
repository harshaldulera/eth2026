/**
 * Onboarding review fix round, deposits: the payer is ONE account whose own transfers pay the intent
 * (dust sent first by someone who saw the memo never takes the vault or unit), a crashed handler is
 * un-stuck, NEW DEPOSIT WINDOW renews in place, and a top-up whose approval closed is noted, not kept silently.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { agentRow } from "@/lib/agents/accounts";
import { HBAR, makeUnit, setupUnitsEnv } from "@/lib/agents/units.test-util";
import { cancelPendingApprovals, fundTopUpFromDeposit } from "@/lib/pay/approvals";
import { requestApproval } from "@/lib/pay";
import type { AccountTransfer } from "@/lib/chain/mirror";
import {
  getIntent,
  intentStatus,
  matchDeposits,
  onDepositConfirmed,
  retryFailed,
  settleIntent,
  STUCK_FUNDING_MS,
  unstickFunding,
  type DepositIntent,
} from "./deposits";
import { renewIntent } from "./renew";

setupUnitsEnv();

const T0 = Date.now();
const ts = (ms: number) => `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1e6).padStart(9, "0")}`;
const intent = (o: Partial<DepositIntent> = {}): DepositIntent => ({
  id: "i1",
  kind: "vault",
  refId: "castle-1",
  code: "abcd2345",
  memo: "siege:abcd2345",
  amountTinybar: 10 * HBAR,
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
const tr = (payer: string, amount: number, n: number): AccountTransfer => ({
  txId: `${payer}-${1000 + n}-1`,
  payer,
  memo: "siege:abcd2345",
  amountToAccount: String(amount),
  consensusTimestamp: ts(T0 + 60_000 + n * 1000),
});

describe("matchDeposits: one paying account", () => {
  it("1 tinybar sent ahead by someone else never makes them the payer", () => {
    const [m] = matchDeposits([intent()], [tr("0.0.666", 1, 1), tr("0.0.100", 10 * HBAR, 2)]);
    expect(m).toMatchObject({ payer: "0.0.100", received: 10 * HBAR, enough: true });
    expect(m!.txs[0]).toMatch(/^0\.0\.100-/);
    expect(m!.others).toBe("refund manually: other payer 0.0.666 sent 1 tinybar");
  });

  it("across passes: the dust payer recorded first is replaced once the real payment lands", () => {
    const [p1] = matchDeposits([intent()], [tr("0.0.666", 1, 1)]);
    expect(p1).toMatchObject({ payer: "0.0.666", received: 1, enough: false });
    const after1 = intent({ state: "underpaid", receivedTinybar: p1!.received, payer: p1!.payer, txs: JSON.stringify(p1!.txs) });
    const [p2] = matchDeposits([after1], [tr("0.0.666", 1, 1), tr("0.0.100", 10 * HBAR, 2)]);
    expect(p2).toMatchObject({ payer: "0.0.100", received: 10 * HBAR, enough: true });
    expect(p2!.others).toContain("other payer 0.0.666 sent 1 tinybar");
  });

  it("other payers' sums survive in the note across passes (no one is credited twice or forgotten)", () => {
    const pass1 = intent({ state: "underpaid", receivedTinybar: 6 * HBAR, payer: "0.0.666", txs: JSON.stringify(["a"]), note: `refund manually: other payer 0.0.100 sent ${5 * HBAR} tinybar` });
    const [m] = matchDeposits([pass1], [tr("0.0.100", 5 * HBAR, 3)]);
    expect(m).toMatchObject({ payer: "0.0.100", received: 10 * HBAR, enough: true });
    expect(m!.others).toBe(`refund manually: other payer 0.0.666 sent ${6 * HBAR} tinybar`);
  });

  it("settleIntent stores the payer and the refund note; the owner of a vault is the real payer", async () => {
    onDepositConfirmed("vault", async () => {});
    db().insert(schema.depositIntents).values(intent()).run();
    const [m] = matchDeposits([getIntent("i1")!], [tr("0.0.666", 1, 1), tr("0.0.100", 10 * HBAR, 2)]);
    expect(await settleIntent("i1", m!)).toBe("funded");
    const row = getIntent("i1")!;
    expect(row.payer).toBe("0.0.100");
    expect(row.note).toContain("other payer 0.0.666 sent 1 tinybar");
    expect(intentStatus("i1")!.note).toContain("refund manually");
  });
});

describe("crashed handlers and renewed windows", () => {
  it("a `funding` intent older than STUCK_FUNDING_MS goes back to failed and is retried", async () => {
    let runs = 0;
    onDepositConfirmed("vault", async () => {
      runs++;
    });
    const claimed = new Date(T0).toISOString();
    db().insert(schema.depositIntents).values(intent({ state: "funding", claimedAt: claimed, receivedTinybar: 10 * HBAR, payer: "0.0.100" })).run();
    expect(unstickFunding(T0 + 1000)).toBe(0);
    expect(unstickFunding(T0 + STUCK_FUNDING_MS + 1000)).toBe(1);
    expect(getIntent("i1")).toMatchObject({ state: "failed", attempts: 1 });
    expect(getIntent("i1")!.error).toMatch(/^handler_interrupted/);
    expect(await retryFailed("i1")).toBe("funded");
    expect(runs).toBe(1);
  });

  it("renewIntent: only an expired, current intent; the unit draft follows the fresh window", async () => {
    process.env.SIEGE_STUB_DEPOSIT_DELAY_MS = "60000";
    const { resetEnv } = await import("@/lib/config/env");
    resetEnv();
    try {
      const { createUnitDraft, getUnitDraft } = await import("@/lib/agents/drafts");
      const d = await createUnitDraft({ name: "Vex", strategy: "authority", budget: String(2 * HBAR), zgKey: "mk-test-key-1" });
      expect(await renewIntent(d.deposit.intentId)).toMatchObject({ ok: false, error: "not_expired" });
      db().update(schema.depositIntents).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).where(eq(schema.depositIntents.id, d.deposit.intentId)).run();
      const r = await renewIntent(d.deposit.intentId);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.intent.memo).not.toBe(d.deposit.memo);
      expect(getUnitDraft(d.draft.id)!.intentId).toBe(r.intent.intentId);
      expect(getIntent(r.intent.intentId)).toMatchObject({ kind: "unit", refId: d.draft.id, amountTinybar: 2 * HBAR });
      // the old one is superseded now
      expect(await renewIntent(d.deposit.intentId)).toMatchObject({ ok: false, error: "superseded" });
    } finally {
      delete process.env.SIEGE_STUB_DEPOSIT_DELAY_MS;
      resetEnv();
    }
  });
});

describe("top-up deposit whose approval closed", () => {
  it("STOP after APPROVE: the late top-up is noted for a manual refund and moves nothing", async () => {
    const u = await makeUnit();
    const a = await requestApproval({ agentId: u.agentId, castleId: "castle_granite_hold", reason: "budget", reasoning: "more", amount: String(2 * HBAR), pressure: 1 });
    db()
      .insert(schema.depositIntents)
      .values(intent({ id: "tu1", kind: "topup", refId: a.id, code: "tttttttt", memo: "siege:tttttttt", amountTinybar: 2 * HBAR, state: "funding", receivedTinybar: 2 * HBAR, payer: "0.0.9" }))
      .run();
    db().update(schema.approvalRequests).set({ depositIntentId: "tu1" }).where(eq(schema.approvalRequests.id, a.id)).run();
    expect(cancelPendingApprovals(u.agentId)).toBe(1);
    const before = agentRow(u.agentId)!.budgetTinybar;
    await fundTopUpFromDeposit(getIntent("tu1")!);
    expect(agentRow(u.agentId)!.budgetTinybar).toBe(before);
    expect(getIntent("tu1")!.note).toMatch(/not_fundable: approval denied, refund manually/);
  });
});
