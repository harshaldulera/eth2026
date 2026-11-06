/**
 * Test-only helpers for the Part 2 route tests (replay, stats): run real ops through the start and
 * message route handlers, then apply what the worker's settle pass would record (app/ may not import
 * the worker): the release / attempt tx on the siege row, plus the matching event.
 */
import { expect } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { emit } from "@/lib/events/bus";
import { STUB_PAYMENT_HEADER } from "@/lib/pay";
import * as startRoute from "@/app/api/siege/start/route";
import * as messageRoute from "@/app/api/siege/[id]/message/route";

const BASE = "http://localhost:3000";

export async function runOp(castleId: string, lines: readonly string[], o: { raider?: string; free?: boolean } = {}): Promise<string> {
  const raider = o.raider ?? "0.0.stub-raider";
  const res = await startRoute.POST(
    new Request(`${BASE}/api/siege/start`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(o.free ? {} : { [STUB_PAYMENT_HEADER]: raider }) },
      body: JSON.stringify(o.free ? { castleId, free: true, wallet: raider } : { castleId }),
    }),
  );
  const body = (await res.json()) as { siegeId?: string };
  expect(res.status, JSON.stringify(body)).toBe(200);
  const id = body.siegeId!;
  for (const text of lines) {
    const r = await messageRoute.POST(new Request(`${BASE}/api/siege/${id}/message`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }), {
      params: Promise.resolve({ id }),
    });
    expect(r.status).toBe(200);
  }
  return id;
}

/** What worker/settle.ts records for an ended op (stub shapes): release for a breach, attempt otherwise. */
export function settle(id: string): void {
  const s = db().select().from(schema.sieges).where(eq(schema.sieges.id, id)).get()!;
  const c = db().select().from(schema.castles).where(eq(schema.castles.id, s.castleId)).get()!;
  const at = new Date().toISOString();
  if (s.status === "broken") {
    if (s.free) {
      emit({ siegeId: id, castleId: s.castleId, type: "release", payload: { castleId: s.castleId, free: true, amount: "0", raider: s.raider } });
    } else {
      const amount = c.potTinybar + c.feeTinybar;
      const txId = `stub:release@${id}`;
      db().update(schema.sieges).set({ releaseTx: txId, releaseAmountTinybar: amount, settledAt: at }).where(eq(schema.sieges.id, id)).run();
      db().update(schema.castles).set({ status: "broken", potTinybar: 0 }).where(eq(schema.castles.id, s.castleId)).run();
      emit({ siegeId: id, castleId: s.castleId, type: "release", payload: { castleId: s.castleId, amount: String(amount), raider: s.raider, txId, hashscanUrl: "#stub", stub: true } });
    }
    return;
  }
  if (s.free) {
    emit({ siegeId: id, castleId: s.castleId, type: "attempt", payload: { castleId: s.castleId, free: true, streak: c.streak } });
    return;
  }
  const fee = c.feeTinybar;
  const castellan = Math.floor((fee * 8000) / 10000);
  const arena = Math.floor((fee * 500) / 10000);
  const pot = fee - castellan - arena;
  const txId = `stub:attempt@${id}`;
  db().update(schema.sieges).set({ attemptTx: txId, settledAt: at }).where(eq(schema.sieges.id, id)).run();
  emit({
    siegeId: id,
    castleId: s.castleId,
    type: "attempt",
    payload: { castleId: s.castleId, split: { castellan: String(castellan), pot: String(pot), arena: String(arena) }, newPot: String(c.potTinybar + pot), streak: c.streak + 1, txId, hashscanUrl: "#stub", stub: true },
  });
}
