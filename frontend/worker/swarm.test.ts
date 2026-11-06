import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
process.env.SIEGE_FAST = "1";
import { arkiv } from "@/lib/arkiv";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { WOODEN_BREAK } from "@/lib/fixtures/raids";
import { siege } from "@/lib/siege";
import { createSwarm, NULL_BATCH_ID } from "@/lib/swarm";
import type { LiveSwarm } from "@/lib/swarm/live";
import { swarmRefFor } from "@/lib/swarm/refs";
import type { PaidReceipt } from "@/lib/types";
import { setWorkerQuiet } from "./log";
import { swarmTick } from "./swarm";

const SECRET = "33".repeat(32);
const paid = (): Omit<PaidReceipt, "siegeId"> => ({ payer: "0.0.raider", amount: "50000000", asset: "0.0.0", txId: "stub:tx", receiptId: "stub:r", at: new Date().toISOString(), facilitator: "stub" }) as never;

/** A content-addressed fake gateway that can be switched off. */
function gateway() {
  const files = new Map<string, Uint8Array>();
  const state = { down: false };
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    if (state.down) throw new TypeError("fetch failed");
    if ((init?.method ?? "GET") === "POST") {
      const body = new Uint8Array(init!.body as Uint8Array);
      const ref = Buffer.from(body).toString("hex").slice(0, 64).padEnd(64, "0");
      files.set(ref, body);
      return new Response(JSON.stringify({ reference: ref }), { status: 201 });
    }
    const hit = files.get(String(input).split("/bytes/")[1] ?? "");
    return hit ? new Response(hit as unknown as BodyInit) : new Response("Not Found", { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch: f, state };
}

describe("the worker's Swarm loop", () => {
  let clock: number;
  let g: ReturnType<typeof gateway>;
  let port: LiveSwarm;
  beforeEach(() => {
    freshFixtureDb();
    setWorkerQuiet(true);
    clock = Date.parse("2026-11-08T09:00:00Z");
    g = gateway();
    port = createSwarm({ mode: "live", gatewayUrl: "https://gw.test", batchId: NULL_BATCH_ID, secret: SECRET }, { fetch: g.fetch, now: () => clock }) as LiveSwarm;
  });
  afterEach(() => vi.restoreAllMocks());

  it("an upload that lands late re-queues the op on Arkiv with its reference; a quiet pass queues nothing", async () => {
    const s = await siege.start({ castleId: "castle_splinter_gate", raider: "0.0.raider", receipt: paid() });
    for (const line of WOODEN_BREAK) await siege.message(s.id, line);
    const ended = (await import("@/lib/siege/read")).getSiege(s.id)!;
    expect(ended.status).toBe("broken");

    // The op ended while the gateway was down: sealed, pending, no live reference.
    g.state.down = true;
    const { ref } = await port.put({ siegeId: s.id, castleId: s.castleId, messages: ended.messages, transcriptHash: ended.transcriptHash! });
    expect(ref).toBe(`swarm-pending:${s.id}`);
    const write = vi.spyOn(arkiv, "writeSiege");

    // First pass, still in backoff: nothing happens.
    g.state.down = false;
    clock += 30_000;
    await swarmTick(clock, port);
    expect(write).not.toHaveBeenCalled();

    // Backoff over: the upload lands and the siege goes back through the Arkiv port.
    clock += 61_000;
    await swarmTick(clock, port);
    const landed = swarmRefFor(s.id)!;
    expect(landed).toMatch(/^[0-9a-f]{64}$/);
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({ id: s.id, status: "broken" });

    // A keep-alive on the same bytes keeps the reference: no re-queue.
    clock += 13 * 60 * 60_000;
    await swarmTick(clock, port);
    expect(swarmRefFor(s.id)).toBe(landed);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("throttles to one pass a minute", async () => {
    const tick = vi.spyOn(port, "tick");
    clock += 48 * 60 * 60_000; // past the last pass the first test made (the throttle is module state)
    await swarmTick(clock, port);
    await swarmTick(clock + 1_000, port);
    expect(tick).toHaveBeenCalledTimes(1);
    await swarmTick(clock + 60_000, port);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
