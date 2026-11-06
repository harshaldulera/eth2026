/** Approvals on operator-funded units: cap asks raise the cap with no HBAR; budget asks go through a top-up deposit. */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { agentRow } from "@/lib/agents/accounts";
import { HBAR, makeUnit, setupUnitsEnv } from "@/lib/agents/units.test-util";
import { checkCaps, decideApproval, listApprovals, requestApproval } from "@/lib/pay";
import { fundTopUpFromDeposit } from "@/lib/pay/approvals";
import { getIntent, matchDeposits, settleIntent } from "@/lib/pay/deposits";

setupUnitsEnv();
const CASTLE = "castle_granite_hold";

async function ask(agentId: string, reason: "per_castle" | "daily" | "budget" | "stop_rule" | "zg_key", amount = 2 * HBAR) {
  return requestApproval({ agentId, castleId: CASTLE, reason, reasoning: "need more", amount: String(amount), pressure: 10 });
}

describe("operator-funded unit approvals", () => {
  it("per_castle APPROVE raises the cap: no top-up, no HBAR, the unit resumes", async () => {
    const u = await makeUnit({ perCastleCap: String(HBAR) });
    const before = agentRow(u.agentId)!;
    expect((await checkCaps(u.agentId, CASTLE, String(1.5 * HBAR))).ok).toBe(false);
    const a = await ask(u.agentId, "per_castle", HBAR);
    expect(agentRow(u.agentId)!.status).toBe("paused");
    const r = await decideApproval(a.id, "approved");
    expect(r.ok && r.approval.status).toBe("approved");
    expect(r.ok && r.approval.topUp).toBeUndefined();
    const after = agentRow(u.agentId)!;
    expect(after.status).toBe("running");
    expect(after.budgetTinybar).toBe(before.budgetTinybar); // nothing moved
    expect(db().select().from(schema.depositIntents).all().filter((i) => i.kind === "topup")).toHaveLength(0);
    // the approved row is the allowance
    const ok = await checkCaps(u.agentId, CASTLE, String(1.5 * HBAR));
    expect(ok.ok).toBe(true);
  });

  it("stop_rule APPROVE resets the loss counter", async () => {
    const u = await makeUnit();
    db().update(schema.raiderAgents).set({ consecutiveLosses: 10 }).where(eq(schema.raiderAgents.id, u.agentId)).run();
    const a = await ask(u.agentId, "stop_rule");
    await decideApproval(a.id, "approved");
    expect(agentRow(u.agentId)).toMatchObject({ consecutiveLosses: 0, status: "running" });
  });

  it("budget APPROVE opens a topup deposit; in stub it confirms inline: budget += received, approved, resumed", async () => {
    const u = await makeUnit();
    const a = await ask(u.agentId, "budget", 2 * HBAR);
    const r = await decideApproval(a.id, "approved");
    expect(r.ok && r.approval.status).toBe("approved");
    expect(r.ok && r.approval.topUp?.txId).toBeTruthy();
    const row = agentRow(u.agentId)!;
    expect(row.budgetTinybar).toBe(7 * HBAR);
    expect(row.status).toBe("running");
    const ap = db().select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, a.id)).get()!;
    expect(ap.depositIntentId).toBeTruthy();
    expect(getIntent(ap.depositIntentId!)).toMatchObject({ kind: "topup", refId: a.id, state: "funded", receivedTinybar: 2 * HBAR });
  });

  it("budget APPROVE without a landed deposit stays pending with a `deposit`, reuses the intent, and the handler approves once", async () => {
    const u = await makeUnit();
    const a = await ask(u.agentId, "budget", 2 * HBAR);
    // an intent that has not been paid yet (a real chain deposit is confirmed by the worker, not inline)
    db()
      .insert(schema.depositIntents)
      .values({
        id: "intent-topup-1",
        kind: "topup",
        refId: a.id,
        code: "abcd2345",
        memo: "siege:abcd2345",
        amountTinybar: 2 * HBAR,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      })
      .run();
    db().update(schema.approvalRequests).set({ depositIntentId: "intent-topup-1" }).where(eq(schema.approvalRequests.id, a.id)).run();

    const again = await decideApproval(a.id, "approved");
    expect(again.ok && again.approval.status).toBe("pending");
    expect(again.ok && again.approval.deposit).toMatchObject({ intentId: "intent-topup-1", memo: "siege:abcd2345", amount: String(2 * HBAR) });
    expect(db().select().from(schema.depositIntents).all().filter((i) => i.kind === "topup")).toHaveLength(1); // reused
    expect((await listApprovals("pending")).find((x) => x.id === a.id)?.deposit?.intentId).toBe("intent-topup-1");
    expect(agentRow(u.agentId)!.budgetTinybar).toBe(5 * HBAR);

    const intent = getIntent("intent-topup-1")!;
    const [m] = matchDeposits([intent], [{ txId: "0.0.5-1-1", payer: "0.0.9", memo: "siege:abcd2345", amountToAccount: String(2 * HBAR), consensusTimestamp: `${Math.floor(Date.now() / 1000)}.000000001` }]);
    expect(await settleIntent("intent-topup-1", m)).toBe("funded");
    expect(agentRow(u.agentId)).toMatchObject({ budgetTinybar: 7 * HBAR, status: "running" });
    // idempotent: a second handler run does not top up twice
    await fundTopUpFromDeposit(getIntent("intent-topup-1")!);
    expect(agentRow(u.agentId)!.budgetTinybar).toBe(7 * HBAR);
    expect((await listApprovals("pending")).find((x) => x.id === a.id)).toBeUndefined();
  });

  it("a budget APPROVE on a stopped unit closes the ask as denied and opens no deposit", async () => {
    const u = await makeUnit();
    const a = await ask(u.agentId, "budget");
    db().update(schema.raiderAgents).set({ status: "stopped" }).where(eq(schema.raiderAgents.id, u.agentId)).run();
    const r = await decideApproval(a.id, "approved");
    expect(r).toEqual({ ok: false, reason: "already_decided" });
    expect(db().select().from(schema.depositIntents).all().filter((i) => i.kind === "topup")).toHaveLength(0);
  });

  it("arena-funded units keep the on-chain top-up (unchanged)", async () => {
    const { createAgent } = await import("@/lib/agents/accounts");
    const arena = await createAgent({ name: "Fixture", budget: String(5 * HBAR) });
    const a = await ask(arena.id, "budget", 2 * HBAR);
    const r = await decideApproval(a.id, "approved");
    expect(r.ok && r.approval.status).toBe("approved");
    expect(r.ok && r.approval.topUp?.stub).toBe(true);
    expect(agentRow(arena.id)!.budgetTinybar).toBe(7 * HBAR);
    expect(db().select().from(schema.depositIntents).all()).toHaveLength(0);
  });

  it("scopes: operator hashes see only their units' asks, public sees only arena units'", async () => {
    const { createAgent } = await import("@/lib/agents/accounts");
    const u = await makeUnit();
    const arena = await createAgent({ name: "Fixture" });
    await ask(u.agentId, "daily");
    await ask(arena.id, "daily");
    const { hashKey } = await import("@/lib/auth/keys");
    const mine = await listApprovals("pending", { kind: "operator", hashes: [hashKey(u.operatorKey)] });
    expect(mine.map((x) => x.agentId)).toEqual([u.agentId]);
    expect((await listApprovals("pending", { kind: "public" })).map((x) => x.agentId)).toEqual([arena.id]);
    expect(await listApprovals("pending", { kind: "operator", hashes: [] })).toEqual([]);
    expect(await listApprovals("pending")).toHaveLength(2);
  });
});
