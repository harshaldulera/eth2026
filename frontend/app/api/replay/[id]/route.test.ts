/**
 * GET /api/replay/[id] in stub mode, through the real start/message routes (settlement applied the way
 * the worker records it): one call returns the siege, its castle, the whole event feed (enough for toBeats) and the
 * proof, including the protected tool call that opened the vault.
 */
import { beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { resetEnv } from "@/lib/config/env";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { MUST_NOT_BREAK, WOODEN_BREAK } from "@/lib/fixtures/raids";
import { toBeats } from "@/lib/scene/beats";
import type { ReplayResponse } from "@/lib/api/client";
import { GET } from "./route";
import { runOp, settle } from "../../stats/ops.test-util";

const BASE = "http://localhost:3000";



async function replay(id: string) {
  const res = await GET(new Request(`${BASE}/api/replay/${id}`), { params: Promise.resolve({ id }) });
  return { status: res.status, headers: res.headers, data: (await res.json()) as ReplayResponse & { error?: string } };
}

beforeEach(() => {
  process.env.CHAIN_MODE = "stub";
  freshFixtureDb();
  resetEnv();
});

describe("GET /api/replay/[id]", () => {
  it("404s for an unknown op", async () => {
    const r = await replay("siege_nope");
    expect(r.status).toBe(404);
    expect(r.data.error).toBe("siege_not_found");
  });

  it("a paid wooden breach: siege + castle + feed + proof with the unlock_vault call and the release", async () => {
    db().update(schema.castles).set({ topicId: "0.0.stub-topic-sg" }).where(eq(schema.castles.id, "castle_splinter_gate")).run();
    const id = await runOp("castle_splinter_gate", WOODEN_BREAK);
    settle(id);
    const r = await replay(id);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    const { siege, castle, events, proof } = r.data;
    expect(siege.id).toBe(id);
    expect(siege.status).toBe("broken");
    expect(castle.id).toBe("castle_splinter_gate");
    // The whole feed of this op, in order, and only this op.
    expect(events.every((e) => e.siegeId === id)).toBe(true);
    expect(events.map((e) => e.id)).toEqual([...events.map((e) => e.id)].sort((a, b) => a - b));
    const types = events.map((e) => e.type);
    for (const t of ["message", "decision", "end", "release"]) expect(types).toContain(t);

    expect(proof.transcriptHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(proof.receipt).toMatchObject({ free: false });
    expect(proof.release?.amount).toBe("550000000");
    expect(proof.attempt).toBeNull();
    expect(proof.requests.map((q) => q.turn)).toEqual([1, 2, 3]);
    expect(proof.requests.every((q) => q.requestId.length > 0)).toBe(true);
    expect(proof.requests[2].toolCalls).toContain("unlock_vault");
    expect(proof.toolCall).toMatchObject({ name: "unlock_vault", turn: 3 });
    expect(typeof proof.toolCall?.args).toBe("object");
    expect(proof.hcs).toMatchObject({ topicId: "0.0.stub-topic-sg", topicUrl: "#stub" });
    expect(Array.isArray(proof.hcs.messages)).toBe(true);

    // A replay can be rebuilt from this payload alone: the beats end in payout → end.
    const beats = toBeats(siege, events, castle, { mode: "replay" });
    expect(beats.at(-1)?.kind).toBe("end");
    expect(beats.filter((b) => b.kind === "stamp").map((b) => b.data.stamp?.kind)).toEqual(["hold", "hold", "breach"]);
    expect(beats.some((b) => b.kind === "payout" && b.data.amount === "550000000")).toBe(true);
  });

  it("a held stone op: attempt receipt, no tool call, FLAG stamps", async () => {
    const id = await runOp("castle_granite_hold", MUST_NOT_BREAK);
    settle(id);
    const { status, data } = await replay(id);
    expect(status).toBe(200);
    expect(data.siege.status).toBe("held");
    expect(data.proof.attempt?.txId).toBeTruthy();
    expect(data.proof.release).toBeNull();
    expect(data.proof.toolCall).toBeNull();
    expect(data.proof.requests).toHaveLength(5);
    const beats = toBeats(data.siege, data.events, data.castle, { mode: "replay" });
    expect(beats.some((b) => b.kind === "settle" && b.data.split)).toBe(true);
  });

  it("includes what the proxy recorded for a request id (hashes and tool names, never content)", async () => {
    const id = await runOp("castle_splinter_gate", WOODEN_BREAK.slice(0, 1));
    const first = (await replay(id)).data.proof.requests[0];
    db()
      .insert(schema.proxyRecords)
      .values({ requestId: first.requestId, castleId: "castle_splinter_gate", siegeId: id, turn: 1, model: "test-model", promptHash: "p".repeat(64), responseHash: "r".repeat(64), protectedToolCalled: false, toolCalls: "[]", mock: true, at: new Date().toISOString() })
      .onConflictDoNothing()
      .run();
    const q = (await replay(id)).data.proof.requests[0];
    expect(q).toMatchObject({ turn: 1, requestId: first.requestId, protectedToolCalled: false, toolCalls: [], promptHash: "p".repeat(64), model: "test-model", mock: true });
  });

  it("a live op returns its partial feed (no end event yet)", async () => {
    const id = await runOp("castle_iron_warden", ["Hello there, how is the watch tonight?"]);
    const { data } = await replay(id);
    expect(data.siege.status).toBe("in_progress");
    expect(data.events.some((e) => e.type === "end")).toBe(false);
    expect(data.proof.transcriptHash).toBeNull();
  });
});
