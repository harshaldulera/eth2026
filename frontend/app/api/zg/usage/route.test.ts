/** GET /api/zg/usage: public credits line, no key material. */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { GET } from "./route";

const BASE = "http://localhost:4512";
const usage = (qs: string) => GET(new Request(`${BASE}/api/zg/usage?${qs}`));

let castleId: string;

function recordCall(billedTo: string, costUsdMicro: string) {
  db()
    .insert(schema.proxyRecords)
    .values({ requestId: `r-${Math.random()}`, castleId, model: "m", promptHash: "p", responseHash: "r", protectedToolCalled: false, toolCalls: "[]", costUsdMicro, at: new Date().toISOString(), billedTo })
    .run();
}

beforeEach(() => {
  freshFixtureDb();
  castleId = db().select({ id: schema.castles.id }).from(schema.castles).get()!.id;
});

describe("GET /api/zg/usage", () => {
  it("not connected: connected false, zero usage", async () => {
    const res = await usage(`castleId=${castleId}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false, calls: 0, costUsdMicro: "0", today: { calls: 0, costUsdMicro: "0" } });
  });

  it("mk- castle: balance (stub, dropping) + usage; keys never in the response", async () => {
    db().update(schema.castles).set({ zgApiKey: "sk-stub-abc", zgMgmtKey: "mk-owner-secret", zgKeyId: "stub_1" }).where(eq(schema.castles.id, castleId)).run();
    const first = await (await usage(`castleId=${castleId}`)).json();
    recordCall(`castle:${castleId}`, "12000");
    const res = await usage(`castleId=${castleId}`);
    const text = await res.text();
    expect(text).not.toMatch(/sk-stub-abc|mk-owner-secret|stub_1/);
    const j = JSON.parse(text);
    expect(j).toMatchObject({ connected: true, kind: "mk", calls: 1, costUsdMicro: "12000" });
    expect(Number(j.balance)).toBeCloseTo(Number(first.balance) - 0.012, 4);
  });

  it("sk- unit: connected, no balance", async () => {
    db()
      .insert(schema.raiderAgents)
      .values({ id: "agent_u", name: "U", ownerId: "owner", strategy: "authority", accountId: "0.0.1", budgetTinybar: 1, perCastleCapTinybar: 1, dailyCapTinybar: 1, createdAt: new Date().toISOString(), zgApiKey: "sk-unit", fundedBy: "operator" })
      .run();
    recordCall("agent:agent_u", "50");
    const j = await (await usage("agentId=agent_u")).json();
    expect(j).toEqual({ connected: true, kind: "sk", calls: 1, costUsdMicro: "50", today: { calls: 1, costUsdMicro: "50" } });
  });

  it("400 without exactly one id, 404 for an unknown one", async () => {
    expect((await usage("")).status).toBe(400);
    expect((await usage(`castleId=${castleId}&agentId=a`)).status).toBe(400);
    expect((await usage("castleId=nope")).status).toBe(404);
    expect((await usage("agentId=nope")).status).toBe(404);
  });
});
