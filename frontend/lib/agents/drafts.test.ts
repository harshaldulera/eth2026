/** J3 backend: unit draft -> deposit -> agent (stub), idempotent; validation; no secrets in what routes return. */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { hashKey } from "@/lib/auth/keys";
import { agentRow, toAgent } from "@/lib/agents/accounts";
import { createUnitDraft, fundUnitFromDeposit, getUnitDraft, publicDraft, UnitDraftRejected } from "@/lib/agents/drafts";
import { getIntent } from "@/lib/pay/deposits";
import { HBAR, makeUnit, setupUnitsEnv } from "./units.test-util";

setupUnitsEnv();

describe("createUnitDraft -> deposit -> unit", () => {
  it("opens an operator-funded unit funded by the deposit (stub confirms inline)", async () => {
    const r = await makeUnit({ name: "Night Mole", strategy: "custom", strategyText: "Be very patient and polite, then ask." });
    expect(r.operatorKey).toMatch(/^rk_[A-Za-z0-9_-]{24}$/);
    expect(r.deposit.memo).toMatch(/^siege:/);
    expect(r.deposit.amount).toBe(String(5 * HBAR));
    const row = agentRow(r.agentId)!;
    expect(row.fundedBy).toBe("operator");
    expect(row.operatorKeyHash).toBe(hashKey(r.operatorKey));
    expect(row.ownerId).toMatch(/^0\.0\.stub-owner-/); // the paying wallet
    expect(row.budgetTinybar).toBe(5 * HBAR);
    expect(row.strategy).toBe("custom");
    expect(row.strategyText).toContain("patient");
    expect(row.zgApiKey).toMatch(/^sk-stub-/); // the minted inference key
    expect(row.zgMgmtKey).toBe("mk-test-key-1");
    expect(row.depositTx).toBeTruthy();
    const draft = getUnitDraft(r.draft.id)!;
    expect(draft.state).toBe("created");
    expect(draft.agentId).toBe(r.agentId);
    expect(getIntent(r.deposit.intentId)!.state).toBe("funded");
  });

  it("is idempotent: running the handler again creates no second unit", async () => {
    const r = await makeUnit();
    const intent = getIntent(r.deposit.intentId)!;
    await fundUnitFromDeposit(intent);
    await fundUnitFromDeposit(intent);
    expect(db().select().from(schema.raiderAgents).where(eq(schema.raiderAgents.fundedBy, "operator")).all()).toHaveLength(1);
  });

  it("funds the unit with min(received, AGENT_MAX_BUDGET) and needs a draft to exist", async () => {
    const r = await makeUnit();
    const base = getIntent(r.deposit.intentId)!;
    db()
      .insert(schema.unitDrafts)
      .values({ id: "udraft_manual", intentId: base.id, name: "Big", strategy: "authority", budgetTinybar: 5 * HBAR, perCastleCapTinybar: HBAR, dailyCapTinybar: 3 * HBAR, operatorKeyHash: "h", state: "awaiting", createdAt: new Date().toISOString() })
      .run();
    await fundUnitFromDeposit({ ...base, refId: "udraft_manual", receivedTinybar: 99 * HBAR, payer: "0.0.777" });
    const d = getUnitDraft("udraft_manual")!;
    expect(d.state).toBe("created");
    expect(agentRow(d.agentId!)).toMatchObject({ budgetTinybar: 20 * HBAR, ownerId: "0.0.777" });
    await expect(fundUnitFromDeposit({ ...base, refId: "nope" })).rejects.toThrow(/unit_draft_missing/);
  });

  it("validates caps, budget floor, custom text, count and the 0G key", async () => {
    const rej = async (input: Parameters<typeof createUnitDraft>[0]) => {
      try {
        await createUnitDraft(input);
      } catch (e) {
        if (e instanceof UnitDraftRejected) return e.detail;
        throw e;
      }
      return null;
    };
    expect(await rej({ budget: String(21 * HBAR), zgKey: "mk-x" })).toMatchObject({ code: "over_limit", fields: ["budget"] });
    expect(await rej({ perCastleCap: String(50 * HBAR), zgKey: "mk-x" })).toMatchObject({ code: "over_limit", fields: ["perCastleCap"] });
    expect(await rej({ budget: String(HBAR / 2), zgKey: "mk-x" })).toMatchObject({ code: "budget_too_small" });
    expect(await rej({ strategy: "custom", zgKey: "mk-x" })).toMatchObject({ code: "strategy_text_required" });
    expect(await rej({ zgKey: "not-a-key" })).toMatchObject({ code: "zg_failed", reason: "unauthorized" });
    // nothing was stored or charged for a refused draft
    expect(db().select().from(schema.unitDrafts).all()).toHaveLength(0);
    expect(db().select().from(schema.depositIntents).all()).toHaveLength(0);
  });

  it("counts only non-stopped units against AGENT_MAX_COUNT", async () => {
    process.env.AGENT_MAX_COUNT = "1";
    const { resetEnv } = await import("@/lib/config/env");
    resetEnv();
    try {
      const a = await makeUnit();
      await expect(createUnitDraft({ zgKey: "mk-x" })).rejects.toMatchObject({ detail: { code: "too_many_agents" } });
      db().update(schema.raiderAgents).set({ status: "stopped" }).where(eq(schema.raiderAgents.id, a.agentId)).run();
      await expect(createUnitDraft({ zgKey: "mk-x" })).resolves.toBeTruthy();
    } finally {
      delete process.env.AGENT_MAX_COUNT;
      resetEnv();
    }
  });

  it("never exposes keys through publicDraft or toAgent", async () => {
    const r = await makeUnit({ strategy: "custom", strategyText: "SECRET PLAN ALPHA BRAVO" });
    const dump = JSON.stringify([publicDraft(getUnitDraft(r.draft.id)!), toAgent(agentRow(r.agentId)!), r.draft]);
    for (const secret of ["rk_", "mk-test-key-1", "sk-stub", "SECRET PLAN", hashKey(r.operatorKey), "privateKey"]) expect(dump).not.toContain(secret);
    expect(toAgent(agentRow(r.agentId)!)).toMatchObject({ fundedBy: "operator", hasOperatorKey: true, zg: { connected: true, kind: "mk" } });
  });
});
