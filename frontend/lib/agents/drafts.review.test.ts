/**
 * Onboarding review fix round, J3 units: no operator-funded unit in RAIDER_ACCOUNT_MODE=shared, withdraw
 * never drains a shared/keyless account, the draft cap counts only open deposit windows, abandoned drafts
 * expire (and revoke their 0G key), a failed intent never leaves a draft behind, overpay is noted.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ stub: true }));
vi.mock("@/lib/config/env", async (orig) => {
  const m = await orig<typeof import("@/lib/config/env")>();
  return { ...m, isStub: () => flags.stub && m.isStub() };
});

import { eq } from "drizzle-orm";
import { resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import * as deposits from "@/lib/pay/deposits";
import { getIntent, LATE_GRACE_MS } from "@/lib/pay/deposits";
import * as zg from "@/lib/zg/connect";
import {
  createUnitDraft,
  expireUnitDrafts,
  fundUnitFromDeposit,
  getUnitDraft,
  MAX_OPEN_UNIT_DRAFTS,
  openUnitDraftCount,
  operatorUnitsAvailable,
  UnitDraftRejected,
} from "./drafts";
import { withdrawUnit } from "./transfer";
import { HBAR, makeUnit, setupUnitsEnv } from "./units.test-util";

setupUnitsEnv();
afterEach(() => {
  flags.stub = true;
  vi.restoreAllMocks();
  delete process.env.RAIDER_ACCOUNT_MODE;
  delete process.env.SIEGE_STUB_DEPOSIT_DELAY_MS;
  resetEnv();
});

const input = { name: "Vex", strategy: "authority", budget: String(2 * HBAR), zgKey: "mk-test-key-1" } as const;

/** A draft whose deposit is still waiting (testnet-like: the stub delay holds the inline confirm back). */
async function waitingDraft() {
  process.env.SIEGE_STUB_DEPOSIT_DELAY_MS = "60000";
  resetEnv();
  return createUnitDraft({ ...input });
}

describe("RAIDER_ACCOUNT_MODE=shared: no red-teamer-funded units", () => {
  it("is refused at the draft (units_unavailable) and in the deposit handler, before any account work", async () => {
    process.env.RAIDER_ACCOUNT_MODE = "shared";
    resetEnv();
    expect(operatorUnitsAvailable()).toBe(true); // stub: no real account behind it
    flags.stub = false;
    expect(operatorUnitsAvailable()).toBe(false);
    const err = await createUnitDraft({ ...input }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnitDraftRejected);
    expect((err as UnitDraftRejected).detail.code).toBe("units_unavailable");
    expect(db().select().from(schema.unitDrafts).all()).toHaveLength(0);
  });

  it("the handler refuses a shared-mode deposit (the draft goes failed, no agent row)", async () => {
    const d = await waitingDraft();
    process.env.RAIDER_ACCOUNT_MODE = "shared";
    resetEnv();
    flags.stub = false;
    const intent = { ...getIntent(d.deposit.intentId)!, receivedTinybar: 2 * HBAR, payer: "0.0.777" };
    await expect(fundUnitFromDeposit(intent)).rejects.toThrow(/units_unavailable/);
    expect(db().select().from(schema.raiderAgents).where(eq(schema.raiderAgents.fundedBy, "operator")).all()).toHaveLength(0);
  });

  it("withdraw refuses a unit without its own key outside stub (never the arena's demo wallet)", async () => {
    const u = await makeUnit();
    db().update(schema.raiderAgents).set({ privateKey: null }).where(eq(schema.raiderAgents.id, u.agentId)).run();
    flags.stub = false;
    const r = await withdrawUnit(u.agentId);
    expect(r).toMatchObject({ ok: false, status: 409, error: "not_operator_funded" });
  });
});

describe("draft cap and expiry", () => {
  it("counts only drafts whose deposit window is open; expired windows free their slot", async () => {
    const d = await waitingDraft();
    expect(openUnitDraftCount()).toBe(1);
    const later = Date.parse(getIntent(d.deposit.intentId)!.expiresAt) + 1000;
    expect(openUnitDraftCount(later)).toBe(0);
  });

  it(`${MAX_OPEN_UNIT_DRAFTS} open drafts -> too_many_drafts; once their windows close a new draft opens`, async () => {
    for (let i = 0; i < MAX_OPEN_UNIT_DRAFTS; i++) await waitingDraft();
    const err = await createUnitDraft({ ...input }).catch((e: unknown) => e);
    expect((err as UnitDraftRejected).detail.code).toBe("too_many_drafts");
    // Close every window (testnet: nobody paid).
    db().update(schema.depositIntents).set({ expiresAt: new Date(Date.now() - 1000).toISOString() }).run();
    await expect(createUnitDraft({ ...input })).resolves.toBeTruthy();
  });

  it("expireUnitDrafts: past the 24 h late grace the draft is expired and its minted 0G key revoked", async () => {
    const revoke = vi.spyOn(zg, "revokeZg");
    const d = await waitingDraft();
    const exp = Date.parse(getIntent(d.deposit.intentId)!.expiresAt);
    expect(await expireUnitDrafts(exp + 1000)).toBe(0); // inside the late grace: a late payment still funds it
    expect(await expireUnitDrafts(exp + LATE_GRACE_MS + 1000)).toBe(1);
    expect(getUnitDraft(d.draft.id)!.state).toBe("expired");
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it("a late deposit on an expired draft still creates the unit", async () => {
    const d = await waitingDraft();
    db().update(schema.unitDrafts).set({ state: "expired" }).where(eq(schema.unitDrafts.id, d.draft.id)).run();
    await fundUnitFromDeposit({ ...getIntent(d.deposit.intentId)!, receivedTinybar: 2 * HBAR, payer: "0.0.777" });
    expect(getUnitDraft(d.draft.id)!.state).toBe("created");
  });

  it("createIntent failing deletes the draft and revokes the minted 0G key (no stuck slot)", async () => {
    vi.spyOn(deposits, "createIntent").mockRejectedValueOnce(new Error("operator_not_configured: x"));
    const revoke = vi.spyOn(zg, "revokeZg");
    await expect(createUnitDraft({ ...input })).rejects.toThrow(/operator_not_configured/);
    expect(db().select().from(schema.unitDrafts).all()).toHaveLength(0);
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe("notes instead of silently kept money", () => {
  it("overpay above AGENT_MAX_BUDGET is noted on the intent", async () => {
    const d = await waitingDraft();
    const intent = { ...getIntent(d.deposit.intentId)!, receivedTinybar: 500 * HBAR, payer: "0.0.777" };
    await fundUnitFromDeposit(intent);
    expect(getIntent(d.deposit.intentId)!.note).toMatch(/overpaid: \d+ tinybar above the unit budget cap, refund manually/);
  });

  it("a second deposit for an already created unit is noted, not used", async () => {
    const u = await makeUnit();
    const other = { ...getIntent(u.deposit.intentId)!, id: "intent-other" };
    db().insert(schema.depositIntents).values({ ...other, code: "zzzzzzzz", memo: "siege:zzzzzzzz" }).run();
    await fundUnitFromDeposit(getIntent("intent-other")!);
    expect(getIntent("intent-other")!.note).toMatch(/not_fundable: unit .* already funded by another deposit/);
    expect(db().select().from(schema.raiderAgents).where(eq(schema.raiderAgents.fundedBy, "operator")).all()).toHaveLength(1);
  });
});
