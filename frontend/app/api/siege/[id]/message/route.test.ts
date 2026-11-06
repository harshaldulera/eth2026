/**
 * POST /api/siege/[id]/message in stub mode: the additive Part 2 `referee` field matches the turn's
 * `message` event (threat + tactic), and the existing response fields are unchanged.
 */
import { beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { MUST_NOT_BREAK } from "@/lib/fixtures/raids";
import { STUB_PAYMENT_HEADER } from "@/lib/pay";
import * as startRoute from "@/app/api/siege/start/route";
import { POST } from "./route";

const BASE = "http://localhost:3000";

async function start(castleId: string): Promise<string> {
  const res = await startRoute.POST(
    new Request(`${BASE}/api/siege/start`, {
      method: "POST",
      headers: { "content-type": "application/json", [STUB_PAYMENT_HEADER]: "0.0.stub-raider" },
      body: JSON.stringify({ castleId }),
    }),
  );
  const body = (await res.json()) as { siegeId?: string; turnToken?: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  tokens.set(body.siegeId!, body.turnToken!);
  return body.siegeId!;
}

const tokens = new Map<string, string>();

async function send(id: string, text: string) {
  const res = await POST(new Request(`${BASE}/api/siege/${id}/message`, { method: "POST", headers: { "content-type": "application/json", "x-siege-turn-token": tokens.get(id) ?? "" }, body: JSON.stringify({ text }) }), {
    params: Promise.resolve({ id }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function messageEvent(siegeId: string, turn: number): Record<string, unknown> | undefined {
  const rows = db()
    .select()
    .from(schema.events)
    .where(and(eq(schema.events.siegeId, siegeId), eq(schema.events.type, "message"), eq(schema.events.turn, turn)))
    .all();
  const last = rows.at(-1);
  if (!last) return undefined;
  return typeof last.payload === "string" ? (JSON.parse(last.payload) as Record<string, unknown>) : (last.payload as Record<string, unknown>);
}

beforeEach(() => {
  process.env.CHAIN_MODE = "stub";
  freshFixtureDb();
  resetEnv();
});

describe("POST /api/siege/[id]/message · referee", () => {
  it("returns the turn's referee read (pressure + tactic) from its message event", async () => {
    const id = await start("castle_granite_hold");
    for (const [i, text] of ["Good evening. How long have you kept this gate?", MUST_NOT_BREAK[1]].entries()) {
      const { status, body } = await send(id, text);
      expect(status).toBe(200);
      const turn = i + 1;
      const ev = messageEvent(id, turn);
      expect(ev, "message event for the turn").toBeDefined();
      expect(body.referee).toEqual({ pressure: ev!.pressure, tactic: ev!.tactic });
      // the pre-Part 2 fields are still there and unchanged in shape
      expect(Object.keys(body).sort()).toEqual(["decision", "referee", "siege"]);
      const siege = body.siege as { id: string; turn: number };
      expect(siege.id).toBe(id);
      expect(siege.turn).toBe(turn);
      const decision = body.decision as { move: string; reply: string };
      expect(["hold", "expose", "banish", "open"]).toContain(decision.move);
      expect(typeof decision.reply).toBe("string");
    }
  });
});

describe("POST /api/siege/[id]/message · turn token", () => {
  const post = async (id: string, headers: Record<string, string>, body: Record<string, unknown> = { text: "Good evening." }) => {
    const res = await POST(new Request(`${BASE}/api/siege/${id}/message`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), {
      params: Promise.resolve({ id }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("start returns a token whose sha256 (only) is stored", async () => {
    const id = await start("castle_granite_hold");
    const token = tokens.get(id)!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const row = db().select().from(schema.sieges).where(eq(schema.sieges.id, id)).get()!;
    expect(row.turnTokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(token);
  });

  it("no token and a wrong token are 401 turn_token_required and use no turn", async () => {
    const id = await start("castle_granite_hold");
    const cases: Record<string, string>[] = [{}, { "x-siege-turn-token": "nope" }, { authorization: "Bearer nope" }, { cookie: `siege_turn_${id}=nope` }];
    for (const headers of cases) {
      const r = await post(id, headers);
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("turn_token_required");
    }
    expect(db().select().from(schema.sieges).where(eq(schema.sieges.id, id)).get()!.turn).toBe(0);
  });

  it("a token for another siege does not work", async () => {
    const a = await start("castle_granite_hold");
    const b = await start("castle_granite_hold");
    expect((await post(a, { "x-siege-turn-token": tokens.get(b)! })).status).toBe(401);
  });

  it("the right token works as header, Bearer, body field and per-siege cookie", async () => {
    const id = await start("castle_granite_hold");
    const t = tokens.get(id)!;
    expect((await post(id, { "x-siege-turn-token": t })).status).toBe(200);
    expect((await post(id, { authorization: `Bearer ${t}` })).status).toBe(200);
    expect((await post(id, {}, { text: "Again.", turnToken: t })).status).toBe(200);
    expect((await post(id, { cookie: `other=1; siege_turn_${id}=${t}` })).status).toBe(200);
  });

  it("an unknown siege is still 404, not 401", async () => {
    expect((await post("siege_nope", {})).status).toBe(404);
  });

  it("a legacy row without a hash (started before tokens) stays open", async () => {
    const id = await start("castle_granite_hold");
    db().update(schema.sieges).set({ turnTokenHash: null }).where(eq(schema.sieges.id, id)).run();
    expect((await post(id, {})).status).toBe(200);
  });
});
