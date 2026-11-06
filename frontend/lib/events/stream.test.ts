import { beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { emit } from "@/lib/events/bus";
import { GET } from "@/app/api/events/stream/route";
import { feedComplete, inFlight, isAwaitingChain } from "@/lib/hooks/useSiege";
import type { Siege, StoredSiegeEvent } from "@/lib/types";
import demo from "@/lib/fixtures/demo-siege.json";

/** Open the SSE route, collect frames for `ms`, then disconnect. */
async function read(query: string, ms = 250, during?: () => void): Promise<{ ids: number[]; types: string[]; raw: string }> {
  const ac = new AbortController();
  const res = await GET(new Request(`http://x/api/events/stream?${query}`, { signal: ac.signal }));
  expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let raw = "";
  const pump = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += dec.decode(value);
    }
  })();
  await new Promise((r) => setTimeout(r, 20));
  during?.();
  await new Promise((r) => setTimeout(r, ms));
  ac.abort();
  await reader.cancel().catch(() => {});
  await pump.catch(() => {});
  const frames = raw.split("\n\n").filter((f) => f.startsWith("id: "));
  return {
    ids: frames.map((f) => Number(/^id: (\d+)/.exec(f)![1])),
    types: frames.map((f) => /\nevent: (\w+)/.exec(f)![1]),
    raw,
  };
}

const ev = (siegeId: string, castleId: string, type: StoredSiegeEvent["type"], turn?: number) =>
  emit({ siegeId, castleId, type, turn, payload: {} });

describe("events stream (SSE)", () => {
  beforeEach(() => {
    freshFixtureDb();
  });

  it("tail=N sends only the newest N events on first connect", async () => {
    for (let i = 1; i <= 5; i++) ev("s1", "c1", "message", i);
    const r = await read("tail=2");
    expect(r.ids).toHaveLength(2);
    expect(r.ids[0]).toBeLessThan(r.ids[1]);
  });

  it("filters by castle and by siege", async () => {
    ev("s1", "c1", "start");
    ev("s2", "c2", "start");
    ev("s3", "c1", "end");
    expect((await read("castleId=c1")).ids).toHaveLength(2);
    expect((await read("siegeId=s2")).ids).toHaveLength(1);
  });

  it("resumes after a cursor without repeating it", async () => {
    const a = ev("s1", "c1", "start");
    const b = ev("s1", "c1", "message", 1);
    const r = await read(`siegeId=s1&cursor=${a.id}`);
    expect(r.ids).toEqual([b.id]);
  });

  it("pushes events emitted in this process while connected, in order", async () => {
    const r = await read("siegeId=live", 150, () => {
      ev("live", "c1", "message", 1);
      ev("live", "c1", "decision", 1);
    });
    expect(r.types).toEqual(["message", "decision"]);
  });

  it("the polling endpoint filters by castle too", async () => {
    ev("s1", "c1", "start");
    ev("s2", "c2", "start");
    const { GET: poll } = await import("@/app/api/events/route");
    const body = (await (await poll(new Request("http://x/api/events?castleId=c2&cursor=0"))).json()) as { events: StoredSiegeEvent[] };
    expect(body.events.map((e) => e.castleId)).toEqual(["c2"]);
  });

  it("an already-aborted request closes at once instead of leaking a bus listener", async () => {
    const ac = new AbortController();
    ac.abort();
    const res = await GET(new Request("http://x/api/events/stream?siegeId=s1", { signal: ac.signal }));
    const { done } = await res.body!.getReader().read();
    expect(done).toBe(true);
  });

  it("a tail stream with nothing yet still delivers later events", async () => {
    ev("old", "c9", "start");
    const r = await read("castleId=c1&tail=5", 150, () => ev("new", "c1", "start"));
    expect(r.types).toEqual(["start"]);
  });
});

describe("useSiege helpers", () => {
  const siege = (): Siege =>
    ({ id: "s", castleId: "c", raider: "r", turn: 1, status: "in_progress", messages: [], free: false, transport: "hosted", createdAt: "" }) as Siege;
  const e = (type: StoredSiegeEvent["type"], turn?: number, id = 1) => ({ id, siegeId: "s", type, turn, payload: {}, at: "" }) as StoredSiegeEvent;

  it("the guardian is thinking between a message and its decision", () => {
    expect(inFlight([e("message", 1)], siege())).toBe(true);
    expect(inFlight([e("message", 1), e("decision", 1, 2)], siege())).toBe(false);
    expect(inFlight([e("message", 1), e("decision", 1, 2), e("message", 2, 3)], siege())).toBe(true);
    expect(inFlight([e("message", 1), e("end", 1, 2)], siege())).toBe(false);
    expect(inFlight([e("message", 1)], { ...siege(), status: "held" })).toBe(false);
  });

  it("waits for the chain only on a paid, ended siege without its tx", () => {
    expect(isAwaitingChain({ ...siege(), status: "broken" })).toBe(true);
    expect(isAwaitingChain({ ...siege(), status: "broken", release: { txId: "x", hashscanUrl: "", amount: "1" } })).toBe(false);
    expect(isAwaitingChain({ ...siege(), status: "held" })).toBe(true);
    expect(isAwaitingChain({ ...siege(), status: "held", free: true })).toBe(false);
    expect(isAwaitingChain({ ...siege(), status: "held", settlement: { state: "void" } })).toBe(false);
    expect(isAwaitingChain(siege())).toBe(false);
  });

  it("a final siege's feed is complete once its end and chain events are in", () => {
    const tx = { txId: "x", hashscanUrl: "", amount: "1" };
    const broken = { ...siege(), status: "broken" as const, release: tx };
    expect(feedComplete(siege(), [e("end", 1)])).toBe(false); // still running
    expect(feedComplete({ ...siege(), status: "broken" }, [e("end", 1)])).toBe(false); // payout on its way
    expect(feedComplete(broken, [e("decision", 1), e("end", 1, 2)])).toBe(false); // release event not in yet
    expect(feedComplete(broken, [e("decision", 1), e("end", 1, 2), e("release", 1, 3)])).toBe(true);
    expect(feedComplete({ ...siege(), status: "held", free: true }, [e("end", 5)])).toBe(true);
    expect(feedComplete({ ...siege(), status: "held", free: true }, [])).toBe(false);
  });

  it("the recorded demo is a paid wooden break that pays out", () => {
    const frames = (demo as unknown as { frames: { event: StoredSiegeEvent; siege: Siege }[] }).frames;
    expect(frames.map((f) => f.event.type)).toEqual(["start", "message", "decision", "message", "decision", "message", "decision", "end", "release"]);
    const last = frames[frames.length - 1].siege;
    expect(last.status).toBe("broken");
    expect(last.free).toBe(false);
    expect(last.release).toBeTruthy();
    // While a message frame shows, the guardian's reply to it is not in the record yet.
    const third = frames[5];
    expect(third.siege.messages.some((m) => m.role === "guardian" && m.turn === third.event.turn)).toBe(false);
    expect(inFlight(frames.slice(0, 6).map((f) => f.event), third.siege)).toBe(true);
  });
});
