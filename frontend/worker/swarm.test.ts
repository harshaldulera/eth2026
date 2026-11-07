import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
process.env.SIEGE_FAST = "1";
import { arkiv } from "@/lib/arkiv";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { WOODEN_BREAK } from "@/lib/fixtures/raids";
import { siege } from "@/lib/siege";
import { createSwarm, NULL_BATCH_ID } from "@/lib/swarm";
import { fakeGateway } from "@/lib/swarm/fake-gateway";
import type { LiveSwarm } from "@/lib/swarm/live";
import { rawSqlite } from "@/lib/db/raw";
import { recordSwarmRef, swarmRefFor } from "@/lib/swarm/refs";
import { uploadRow } from "@/lib/swarm/store";
import type { PaidReceipt } from "@/lib/types";
import { setWorkerQuiet } from "./log";
import { swarmTick } from "./swarm";

const SECRET = "33".repeat(32);
const paid = (): Omit<PaidReceipt, "siegeId"> => ({ free: false, txId: `stub:x402@${Date.now()}`, payer: "0.0.raider", amount: "50000000", asset: "0.0.0", network: "hedera:testnet", hashscanUrl: "#stub", stub: true });

const gateway = fakeGateway;

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

  it("a transcript from before it was named moves to transcript.json, and the op goes back to Arkiv with the new reference", async () => {
    const s = await siege.start({ castleId: "castle_splinter_gate", raider: "0.0.raider", receipt: paid() });
    for (const line of WOODEN_BREAK) await siege.message(s.id, line);
    const ended = (await import("@/lib/siege/read")).getSiege(s.id)!;
    const { ref } = await port.put({ siegeId: s.id, castleId: s.castleId, messages: ended.messages, transcriptHash: ended.transcriptHash! });
    // Make it look as it did before: raw bytes on the gateway, format "bytes".
    const old = g.seedBytes(new Uint8Array(uploadRow(s.id)!.body));
    rawSqlite("SELECT 1").prepare("UPDATE swarm_uploads SET ref = ?, format = 'bytes' WHERE siege_id = ?").run(old, s.id);
    recordSwarmRef(s.id, old);
    expect(old).not.toBe(ref);
    const write = vi.spyOn(arkiv, "writeSiege");

    clock += 24 * 60 * 60_000; // well past any earlier pass (the throttle is module state)
    await swarmTick(clock, port);
    expect(swarmRefFor(s.id)).toBe(ref); // the named-file reference, same as a fresh upload of these bytes
    expect(uploadRow(s.id)).toMatchObject({ ref, format: "file" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toMatchObject({ id: s.id });
  });

  it("throttles to one pass a minute", async () => {
    const tick = vi.spyOn(port, "tick");
    clock += 48 * 60 * 60_000; // past the last pass the earlier tests made (the throttle is module state)
    await swarmTick(clock, port);
    await swarmTick(clock + 1_000, port);
    expect(tick).toHaveBeenCalledTimes(1);
    await swarmTick(clock + 60_000, port);
    expect(tick).toHaveBeenCalledTimes(2);
  });
});
