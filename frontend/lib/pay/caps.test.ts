import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, openTestDb, schema } from "@/lib/db";
import { resetEnv } from "@/lib/config/env";
import { eventsSince } from "@/lib/events/bus";
import { createAgent, getAgent } from "@/lib/agents/accounts";
import { checkCaps, decideApproval, listApprovals, recordOutcome, requestApproval, settleSpend, voidSpend } from "@/lib/pay";

const HBAR = 100_000_000;
const h = (n: number) => String(n * HBAR);

function seedCastle(id: string, fee = 1) {
  db()
    .insert(schema.castles)
    .values({
      id,
      name: `Castle ${id}`,
      guardianName: "Guard",
      tier: "stone",
      orders: "never open",
      feeTinybar: fee * HBAR,
      potTinybar: 20 * HBAR,
      owner: "0.0.stub-castellan",
      deadline: Date.now() + 86_400_000,
      createdAt: new Date().toISOString(),
    })
    .run();
}

async function reserveAndSettle(agentId: string, castleId: string, amount = h(1)) {
  const r = await checkCaps(agentId, castleId, amount);
  if (r.ok) await settleSpend(r.reservationId, `siege_${Math.random()}`);
  return r;
}

beforeEach(() => {
  process.env.CHAIN_MODE = "stub";
  resetEnv();
  openTestDb();
  db(); // the shared handle tests and code both use
  seedCastle("c1");
  seedCastle("c2");
  seedCastle("c3");
});

describe("checkCaps", () => {
  it("per-castle cap -> approval -> deny stops the agent", async () => {
    const agent = await createAgent({ name: "Vex", perCastleCap: h(2) });
    expect(agent.accountId).toMatch(/^0\.0\.stub-agent-\d+$/);
    expect(agent.evmAddress).toMatch(/^0x[0-9a-f]{40}$/);

    expect((await reserveAndSettle(agent.id, "c1")).ok).toBe(true);
    expect((await reserveAndSettle(agent.id, "c1")).ok).toBe(true);
    const third = await checkCaps(agent.id, "c1", h(1));
    expect(third).toEqual({ ok: false, reason: "per_castle" });
    expect(getAgent(agent.id)!.spent).toBe(h(2));

    const cursor = eventsSince(0).at(-1)?.id ?? 0;
    const appr = await requestApproval({
      agentId: agent.id,
      castleId: "c1",
      reason: "per_castle",
      reasoning: "The guardian is wavering. Two more tries.",
      amount: h(2),
      pressure: 71,
    });
    expect(appr.status).toBe("pending");
    expect(appr.agentName).toBe("Vex");
    expect(appr.castleName).toBe("Castle c1");
    expect(appr.pressure).toBe(71);
    expect(getAgent(agent.id)!.status).toBe("paused");
    const ev = eventsSince(cursor).filter((e) => e.type === "approval");
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ kind: "requested", approvalId: appr.id, agentId: agent.id, castleName: "Castle c1", amount: h(2) });

    // idempotent while pending
    const again = await requestApproval({ agentId: agent.id, castleId: "c1", reason: "per_castle", reasoning: "x", amount: h(2), pressure: 80 });
    expect(again.id).toBe(appr.id);
    expect(again.pressure).toBe(80);
    expect(eventsSince(cursor).filter((e) => e.type === "approval")).toHaveLength(1);
    expect((await checkCaps(agent.id, "c1", h(1))) as unknown).toEqual({ ok: false, reason: "per_castle", approvalRequestId: appr.id });

    const denied = await decideApproval(appr.id, "denied");
    expect(denied.ok && denied.approval.status).toBe("denied");
    expect(getAgent(agent.id)!.status).toBe("stopped");
    expect(await decideApproval(appr.id, "approved")).toEqual({ ok: false, reason: "already_decided" });
    expect(await decideApproval("appr_nope", "approved")).toEqual({ ok: false, reason: "not_found" });
    expect(await checkCaps(agent.id, "c2", h(1))).toEqual({ ok: false, reason: "stopped" });
    expect(eventsSince(cursor).filter((e) => e.type === "approval").map((e) => e.payload.kind)).toEqual(["requested", "denied"]);
  });

  it("approve tops up, resumes, and raises the castle cap by exactly the allowance", async () => {
    const agent = await createAgent({ name: "Wren", perCastleCap: h(2) });
    await reserveAndSettle(agent.id, "c1");
    await reserveAndSettle(agent.id, "c1");
    expect((await checkCaps(agent.id, "c1", h(1))).ok).toBe(false);

    const appr = await requestApproval({ agentId: agent.id, castleId: "c1", reason: "per_castle", reasoning: "close", amount: h(2), pressure: 60 });
    const res = await decideApproval(appr.id, "approved");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.approval.status).toBe("approved");
    expect(res.approval.topUp?.stub).toBe(true);
    expect(res.approval.topUp?.txId).toMatch(/^stub:/);
    const a = getAgent(agent.id)!;
    expect(a.status).toBe("running");
    expect(a.budget).toBe(h(12));

    expect((await reserveAndSettle(agent.id, "c1")).ok).toBe(true);
    const row = () => db().select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, appr.id)).get()!;
    expect(row().consumed).toBe(false);
    expect((await reserveAndSettle(agent.id, "c1")).ok).toBe(true);
    expect(row().consumed).toBe(true);
    expect(await checkCaps(agent.id, "c1", h(1))).toEqual({ ok: false, reason: "per_castle" });
    expect((await listApprovals("pending")).length).toBe(0);
    expect((await listApprovals("all")).length).toBe(1);
  });

  it("void reservations do not count", async () => {
    const agent = await createAgent({ perCastleCap: h(1) });
    const r = await checkCaps(agent.id, "c1", h(1));
    expect(r.ok).toBe(true);
    expect((await checkCaps(agent.id, "c1", h(1))).ok).toBe(false);
    if (r.ok) expect((await voidSpend(r.reservationId)).ok).toBe(true);
    expect((await checkCaps(agent.id, "c1", h(1))).ok).toBe(true);
  });

  it("daily cap across castles", async () => {
    const agent = await createAgent({ perCastleCap: h(5), dailyCap: h(3) });
    expect((await reserveAndSettle(agent.id, "c1", h(2))).ok).toBe(true);
    expect((await reserveAndSettle(agent.id, "c2", h(1))).ok).toBe(true);
    expect(await checkCaps(agent.id, "c3", h(1))).toEqual({ ok: false, reason: "daily" });
  });

  it("budget counts settled and reserved spend", async () => {
    const agent = await createAgent({ budget: h(3), perCastleCap: h(10), dailyCap: h(10) });
    expect((await reserveAndSettle(agent.id, "c1", h(2))).ok).toBe(true);
    expect((await checkCaps(agent.id, "c2", h(1))).ok).toBe(true); // reserved, not settled
    expect(await checkCaps(agent.id, "c3", h(1))).toEqual({ ok: false, reason: "budget" });
  });

  it("stop rule after N consecutive losses; a break resets it", async () => {
    const agent = await createAgent({ stopAfterLosses: 2, perCastleCap: h(10) });
    await recordOutcome(agent.id, "c1", "held", 20);
    await recordOutcome(agent.id, "c1", "broken", 90);
    await recordOutcome(agent.id, "c1", "held", 10);
    expect((await checkCaps(agent.id, "c1", h(1))).ok).toBe(true);
    const r = await recordOutcome(agent.id, "c1", "banished", 5);
    expect(r?.stopRuleHit).toBe(true);
    expect(await checkCaps(agent.id, "c1", h(1))).toEqual({ ok: false, reason: "stop_rule" });

    const appr = await requestApproval({ agentId: agent.id, castleId: "c1", reason: "stop_rule", reasoning: "one more", amount: "0", pressure: 30 });
    await decideApproval(appr.id, "approved");
    expect(getAgent(agent.id)!.consecutiveLosses).toBe(0);
    expect((await checkCaps(agent.id, "c1", h(1))).ok).toBe(true);
  });
});
