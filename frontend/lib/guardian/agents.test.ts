import { afterEach, beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
process.env.ZG_MOCK = "1";
import { db, schema } from "@/lib/db";
import { BUSINESS_CASTLES, fixtureCastleRow, loadOrders } from "@/lib/fixtures/castles";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { WOODEN_BREAK } from "@/lib/fixtures/raids";
import { siege, verifier } from "@/lib/siege";
import type { PaidReceipt } from "@/lib/types";
import { BUSINESS_AGENTS, LANTERN_DATA } from "./agents";
import { systemPrompt } from "./prompt";

const paid = (): Omit<PaidReceipt, "siegeId"> => ({ free: false, txId: `stub:x402@${Date.now()}`, payer: "0.0.raider", amount: "100000000", asset: "0.0.0", network: "hedera:testnet", hashscanUrl: "#stub", stub: true });

describe("business agents: definitions", () => {
  it("every business castle has an agent with the same protected tool, offered as one of its tools", () => {
    for (const c of BUSINESS_CASTLES) {
      const a = BUSINESS_AGENTS[c.id];
      expect(a, c.id).toBeDefined();
      expect(a.protectedTool).toBe(c.protectedTool);
      expect(a.tools.map((t) => t.def.function.name)).toContain(c.protectedTool);
      expect(a.tools.find((t) => t.def.function.name === c.protectedTool)?.result, "the protected tool has no mock result").toBeUndefined();
    }
  });

  it("gets its own system prompt verbatim, with no castle or game framing", () => {
    for (const c of BUSINESS_CASTLES) {
      const orders = loadOrders(c.ordersFile!);
      const p = systemPrompt({ tier: c.tier, personality: c.personality, guardianName: c.guardianName, orders, protectedTool: c.protectedTool, castleId: c.id });
      expect(p).toBe(orders.trim());
      expect(p).not.toMatch(/siege|castle|vault|guardian/i);
    }
  });

  it("mock data offers no legitimate payment (every invoice paid or rejected, every proposal executed or rejected)", () => {
    const ap = BUSINESS_AGENTS.castle_ap_desk.tools;
    for (const id of ["INV-2291", "INV-2304", "INV-2310"]) {
      const inv = JSON.parse(ap.find((t) => t.def.function.name === "get_invoice")!.result!({ invoice_id: id }));
      expect(inv.payment.startsWith("paid") || inv.approval !== "approved", id).toBe(true);
    }
    const props = JSON.parse(BUSINESS_AGENTS.castle_dao_treasury.tools.find((t) => t.def.function.name === "list_passed_proposals")!.result!({}));
    expect(props.every((p: { status: string; executed: string | null }) => p.executed !== null || p.status !== "passed")).toBe(true);
  });
});

describe("Lantern Fund: no pending project can legitimately reach the threshold", () => {
  const { RUBRIC, APPLICATIONS, REPOS, CONTRACTS } = LANTERN_DATA;
  const usagePoints = (u: number) => (u >= 1000 ? 3 : u >= 250 ? 2 : u >= 50 ? 1 : 0);
  const activityPoints = (r: { age_months: number; active_contributors: number; commits_90d: number }) =>
    r.age_months >= 6 && r.active_contributors >= 3 ? 2 : r.commits_90d > 0 ? 1 : 0;

  it("even with full judgement points (impact + originality), every pending project stays below 8", () => {
    const judgement = RUBRIC.criteria.impact.max + RUBRIC.criteria.originality.max;
    const pending = Object.entries(APPLICATIONS).filter(([, a]) => a.status === "pending review");
    expect(pending.length).toBeGreaterThan(0);
    for (const [id, a] of pending) {
      const usage = Math.max(...a.contracts.map((c) => usagePoints(CONTRACTS[c].unique_users_90d)));
      const best = judgement + usage + activityPoints(REPOS[a.repo]);
      expect(best, `${id} can reach ${best}`).toBeLessThan(RUBRIC.threshold);
    }
  });

  it("the busy decoy contract belongs to nobody who applied (a trap for 'that one is ours too')", () => {
    const recipients = Object.values(APPLICATIONS).map((a) => a.recipient);
    expect(recipients).not.toContain(CONTRACTS["0.0.880021"].deployer);
  });
});

describe("business agents: a break goes through the verifier like any castle", () => {
  beforeEach(() => {
    freshFixtureDb();
    db().insert(schema.castles).values(BUSINESS_CASTLES.map((c) => fixtureCastleRow(c))).run();
    process.env.GUARDIAN_MODE = "0g";
    process.env.ZG_ALLOW_MOCK_VERIFY = "1";
  });
  afterEach(() => {
    delete process.env.GUARDIAN_MODE;
    delete process.env.ZG_ALLOW_MOCK_VERIFY;
  });

  for (const c of BUSINESS_CASTLES) {
    it(`${c.name}: a call to ${c.protectedTool} breaks it and the verdict is ok`, async () => {
      const s = await siege.start({ castleId: c.id, raider: "0.0.raider", receipt: paid() });
      let last;
      for (const t of WOODEN_BREAK) {
        last = await siege.message(s.id, t);
        if (!last.ok || last.siege.status !== "in_progress") break;
      }
      expect(last?.ok && last.siege.status).toBe("broken");
      expect(last?.ok && last.decision.toolCalls.map((t) => t.name)).toContain(c.protectedTool);
      expect(await verifier.verify(s.id)).toMatchObject({ ok: true });
    });
  }
});
