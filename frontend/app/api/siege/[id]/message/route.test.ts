/**
 * POST /api/siege/[id]/message in stub mode: the additive Part 2 `referee` field matches the turn's
 * `message` event (threat + tactic), and the existing response fields are unchanged.
 */
import { beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
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
  const body = (await res.json()) as { siegeId?: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.siegeId!;
}

async function send(id: string, text: string) {
  const res = await POST(new Request(`${BASE}/api/siege/${id}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }), {
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
