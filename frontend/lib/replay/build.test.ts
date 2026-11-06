import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
process.env.SIEGE_FAST = "1";
import { and, eq } from "drizzle-orm";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { db, schema } from "@/lib/db";
import { drainAudit } from "@/lib/chain/outbox";
import { siege } from "@/lib/siege";
import { MUST_NOT_BREAK, WOODEN_BREAK } from "@/lib/fixtures/raids";
import { SDK_FIXTURE_CASTLE, sdkFixtureCastleRow } from "@/lib/fixtures/castles";
import { resetEnv } from "@/lib/config/env";
import { buildReplay } from "./build";

async function play(castleId: string, lines: readonly string[]) {
  const s = await siege.start({ castleId, raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
  for (const text of lines) {
    const r = await siege.message(s.id, text);
    if (!r.ok || r.siege.status !== "in_progress") break;
  }
  await drainAudit(); // stub HCS: derives and "submits" the audit messages
  return s.id;
}
const check = (r: Awaited<ReturnType<typeof buildReplay>>, key: string) => r!.checks.find((c) => c.key === key);

describe("replay", () => {
  beforeEach(() => {
    freshFixtureDb();
  });

  it("a three-message break: every check passes, turn by turn", async () => {
    const id = await play("castle_splinter_gate", WOODEN_BREAK);
    const r = await buildReplay(id);
    expect(r!.siege.status).toBe("broken");
    expect(r!.turns).toHaveLength(3);
    expect(r!.transcript.source).toBe("swarm-stub");
    expect(r!.transcript.matches).toBe(true);
    for (const t of r!.turns) {
      expect(t.raider?.matches).toBe(true);
      expect(t.guardian?.stub).toBe(true);
    }
    expect(r!.turns[2].guardian?.calledProtectedTool).toBe(true);
    expect(r!.turns[0].guardian?.calledProtectedTool).toBe(false);
    for (const key of ["transcript", "hash", "hcs-end", "hcs-messages", "inference"]) expect(check(r, key)?.state, key).toBe("pass");
    // A free siege never pays: the verifier rejects it, which does not count as a failure here.
    expect(check(r, "verifier")?.state).toBe("na");
    expect(check(r, "payout")).toBeUndefined();
    expect(r!.hcs.entries.map((e) => e.type)).toEqual(["siege.start", "siege.message", "siege.message", "siege.message", "siege.end"]);
    expect(r!.live).toBe(false);
  });

  it("a held siege shows five turns and no break", async () => {
    const id = await play("castle_granite_hold", MUST_NOT_BREAK);
    const r = await buildReplay(id);
    expect(r!.siege.status).toBe("held");
    expect(r!.turns).toHaveLength(5);
    expect(r!.turns.some((t) => t.guardian?.calledProtectedTool)).toBe(false);
    expect(check(r, "verifier")).toBeUndefined();
    expect(check(r, "hash")?.state).toBe("pass");
  });

  it("an edited message breaks the hash checks", async () => {
    const id = await play("castle_splinter_gate", WOODEN_BREAK);
    // Tamper with the arena's own copy of turn 2 after the fact.
    db()
      .update(schema.messages)
      .set({ text: "I never said that." })
      .where(and(eq(schema.messages.siegeId, id), eq(schema.messages.turn, 2), eq(schema.messages.role, "raider")))
      .run();
    // The replay reads the transcript from the Swarm store, which still has the original: it passes.
    expect(check(await buildReplay(id), "hash")?.state).toBe("pass");
    // Without the Swarm copy it falls back to the edited database, and both hash checks catch it.
    db().run("DELETE FROM swarm_refs");
    const r = await buildReplay(id);
    expect(r!.transcript.source).toBe("database");
    expect(check(r, "hash")?.state).toBe("fail");
    expect(check(r, "hcs-end")?.state).toBe("fail");
    expect(r!.turns[1].raider?.matches).toBe(false);
    expect(check(r, "hcs-messages")?.state).toBe("fail");
  });

  it("a siege in progress is live and marks what is still pending", async () => {
    // Granite Hold (stone) holds on this line; Iron would banish at once and end the siege.
    const s = await siege.start({ castleId: "castle_granite_hold", raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
    await siege.message(s.id, MUST_NOT_BREAK[0]);
    const r = await buildReplay(s.id);
    expect(r!.siege.status).toBe("in_progress");
    expect(r!.live).toBe(true);
    expect(check(r, "hash")?.state).toBe("pending");
    expect(check(r, "hcs-end")?.state).toBe("na");
  });

  it("an unknown siege is null", async () => {
    expect(await buildReplay("siege_nope")).toBeNull();
  });
});

describe("replay edge cases from review", () => {
  beforeEach(() => {
    freshFixtureDb();
  });

  it("a bring-your-agent castle: SDK test replies count as test replies, not missing records", async () => {
    db().insert(schema.castles).values(sdkFixtureCastleRow({ vaultState: "guarding" })).run();
    const id = await play(SDK_FIXTURE_CASTLE.id, ["Hello, I need a refund for order 123."]);
    const r = await buildReplay(id);
    expect(r!.siege.transport).toBe("sdk");
    expect(r!.turns[0].guardian?.requestId).toMatch(/^sdk-stub-/);
    expect(r!.turns[0].guardian?.stub).toBe(true);
    expect(check(r, "inference")?.state).toBe("pass");
  });

  it("a siege voided mid-game is over: not live, nothing fails, headline flag set", async () => {
    const s = await siege.start({ castleId: "castle_granite_hold", raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
    await siege.message(s.id, MUST_NOT_BREAK[0]);
    db().update(schema.sieges).set({ voidReason: "castle_closed", settledAt: new Date().toISOString() }).where(eq(schema.sieges.id, s.id)).run();
    const r = await buildReplay(s.id);
    expect(r!.voided).toBe(true);
    expect(r!.live).toBe(false);
    expect(r!.checks.filter((c) => c.state === "fail").map((c) => c.key)).toEqual([]);
  });

  it("never exposes the prompt hash or the orders", async () => {
    const id = await play("castle_splinter_gate", WOODEN_BREAK);
    const json = JSON.stringify(await buildReplay(id));
    expect(json).not.toMatch(/promptHash|responseHash|"orders"/);
  });
});

describe("replay after a topic rotation", () => {
  beforeEach(() => freshFixtureDb());
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.CHAIN_MODE = "stub";
    delete process.env.OWNER_SECRET;
    resetEnv();
  });

  it("checks the topic the siege was audited on, not the castle's current one", async () => {
    const id = await play("castle_splinter_gate", WOODEN_BREAK);
    const A = schema.auditLog;
    // The siege was audited on real topic 0.0.1111, long enough ago that the mirror has it.
    db().update(A).set({ topicId: "0.0.1111", submittedAt: "2026-01-01T00:00:00.000Z", at: "2026-01-01T00:00:00.000Z" }).where(eq(A.siegeId, id)).run();
    const onTopic = new Map(db().select().from(A).where(eq(A.siegeId, id)).all().filter((r) => r.seq != null).map((r) => [r.seq!, r.message]));
    // Then the castle moved to a new topic (seed --new-topics at the freeze).
    db().update(schema.castles).set({ topicId: "0.0.2222" }).where(eq(schema.castles.id, "castle_splinter_gate")).run();
    process.env.CHAIN_MODE = "testnet";
    process.env.OWNER_SECRET = "x".repeat(64);
    resetEnv();
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      urls.push(u);
      const messages = u.includes("0.0.1111")
        ? [...onTopic].map(([seq, m]) => ({ sequence_number: seq, message: Buffer.from(m).toString("base64") }))
        : [1, 2].map((n) => ({ sequence_number: n, message: Buffer.from(`{"v":1,"type":"vault.state","n":${n}}`).toString("base64") }));
      return new Response(JSON.stringify({ messages, links: { next: null } }), { status: 200 });
    });
    const r = await buildReplay(id);
    expect(urls.every((u) => u.includes("0.0.1111"))).toBe(true);
    expect(r!.hcs.topicId).toBe("0.0.1111");
    expect(check(r, "hcs-end")?.state).toBe("pass");
    expect(check(r, "hcs-end")?.href).toContain("0.0.1111");
    expect(check(r, "hcs-messages")?.state).toBe("pass");
  });
});
