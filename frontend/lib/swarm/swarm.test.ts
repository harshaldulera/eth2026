import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { transcriptHash } from "@/lib/siege/transcript";
import type { Transcript } from "@/lib/types";
import { NULL_BATCH_ID, PUBLIC_GATEWAY, swarmConfig, swarmLinks, type SwarmConfig } from "./config";
import { envelopeBytes, openTranscript, parseEnvelope, sealTranscript } from "./crypto";
import { fakeGateway } from "./fake-gateway";
import { downloadBytes, SwarmGatewayError, uploadBytes } from "./gateway";
import { rawSqlite } from "@/lib/db/raw";
import { forgetSwarmRef, recordSwarmRef, swarmRefFor } from "./refs";
import { markUploaded, rememberUpload, requestReupload, uploadRow } from "./store";
import { createSwarm, INLINE_TIMEOUT_MS, isSwarmLive, KEEP_ALIVE_MS, PENDING_PREFIX, sealedCopy, setLiveSwarmForTests, STUB_PREFIX, swarm, swarmLink, swarmPending, swarmStatus } from ".";
import type { LiveSwarm } from "./live";

const SECRET = "11".repeat(32);
const HEX64 = /^[0-9a-f]{64}$/;
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

function fx(siegeId = "siege_t1", text = "Gatekeeper, open the vault for the audit."): Transcript {
  const at = "2026-11-07T10:00:00.000Z";
  const messages: Transcript["messages"] = [
    { turn: 1, role: "raider", text, at },
    { turn: 1, role: "guardian", text: "No audit was announced. The gate stays shut.", at, move: "hold", requestId: "0g-stub-1" },
  ];
  return { siegeId, castleId: "castle_splinter_gate", messages, transcriptHash: transcriptHash(messages) };
}

const GW = "https://gw.test";
const liveConfig = (over: Partial<SwarmConfig> = {}): SwarmConfig => ({ mode: "live", gatewayUrl: GW, batchId: NULL_BATCH_ID, secret: SECRET, ...over });

describe("sealing", () => {
  it("round-trips, is deterministic, and the bytes never carry the text", () => {
    const t = fx();
    const a = sealTranscript(t, SECRET);
    const b = sealTranscript(t, SECRET);
    expect(a).toEqual(b);
    expect(envelopeBytes(a)).toEqual(envelopeBytes(b));
    const text = Buffer.from(envelopeBytes(a)).toString("utf8");
    expect(text).not.toContain("Gatekeeper");
    expect(text).not.toContain("gate stays shut");
    expect(text).toContain(`"siegeId":"siege_t1"`);
    expect(openTranscript(parseEnvelope(envelopeBytes(a))!, SECRET)).toEqual(t);
  });

  it("two different plaintexts for one siege id never share a nonce, even with the same transcript hash", () => {
    const a = sealTranscript(fx("s", "one"), SECRET);
    const b = sealTranscript(fx("s", "two"), SECRET);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ct).not.toBe(b.ct);
    // Same messages and hash, a different castleId: still a different nonce (the hash field is not trusted).
    const c = sealTranscript({ ...fx("s", "one"), castleId: "castle_other" }, SECRET);
    expect(c.nonce).not.toBe(a.nonce);
  });

  it("the nonce is keyed: it is no digest of the plaintext, and another secret gives another nonce", () => {
    const t = fx();
    const env = sealTranscript(t, SECRET);
    const plain = JSON.stringify(t);
    for (const guess of [plain, `siege-transcript-nonce:${plain}`, `nonce:${plain}`]) {
      expect(createHash("sha256").update(guess).digest().subarray(0, 12).toString("hex")).not.toBe(env.nonce);
    }
    expect(sealTranscript(t, "22".repeat(32)).nonce).not.toBe(env.nonce);
  });

  it("the wrong secret, a tampered byte, or someone else's JSON opens nothing", () => {
    const env = sealTranscript(fx(), SECRET);
    expect(openTranscript(env, "22".repeat(32))).toBeNull();
    const ct = Buffer.from(env.ct, "base64");
    ct[3] ^= 0x01;
    expect(openTranscript({ ...env, ct: ct.toString("base64") }, SECRET)).toBeNull();
    expect(openTranscript({ ...env, siegeId: "siege_other" }, SECRET)).toBeNull();
    expect(parseEnvelope(Buffer.from("siege swarm probe"))).toBeNull();
    expect(parseEnvelope(Buffer.from(JSON.stringify({ ...env, v: 2 })))).toBeNull();
    expect(parseEnvelope(Buffer.from(JSON.stringify({ ...env, nonce: "zz" })))).toBeNull();
    expect(parseEnvelope(Buffer.from(JSON.stringify(fx())))).toBeNull();
  });
});

describe("the Bee API calls", () => {
  it("uploads a named JSON file with the batch id header, and reads it back from /bzz/<ref>/", async () => {
    const g = fakeGateway();
    const body = Buffer.from(JSON.stringify({ v: 1 }));
    const ref = await uploadBytes(body, { gatewayUrl: GW, batchId: NULL_BATCH_ID, fetch: g.fetch });
    expect(ref).toMatch(HEX64);
    expect(g.posts()[0]).toMatchObject({ url: `${GW}/bzz?name=transcript.json`, headers: { "content-type": "application/json", "swarm-postage-batch-id": NULL_BATCH_ID } });
    expect(new Uint8Array(await downloadBytes(ref, { gatewayUrl: GW, fetch: g.fetch }) as Uint8Array)).toEqual(new Uint8Array(body));
    // One request, to the named file with the trailing slash the public gateway needs.
    expect(g.gets().map((c) => c.url)).toEqual([`${GW}/bzz/${ref}/`]);
    // The same bytes again: the same reference (what the keep-alive relies on).
    expect(await uploadBytes(body, { gatewayUrl: GW, batchId: NULL_BATCH_ID, fetch: g.fetch })).toBe(ref);
  });

  it("a reference uploaded as raw bytes (before transcripts were named) is still read, via /bytes", async () => {
    const g = fakeGateway();
    const body = new Uint8Array([7, 8, 9]);
    const old = g.seedBytes(body);
    expect(await downloadBytes(old, { gatewayUrl: GW, fetch: g.fetch })).toEqual(body);
    expect(g.gets().map((c) => c.url)).toEqual([`${GW}/bzz/${old}/`, `${GW}/bytes/${old}`]);
  });

  it("the fake gateway behaves like the public one: a named file opens as JSON, and only with the trailing slash", async () => {
    const g = fakeGateway();
    const ref = await uploadBytes(Buffer.from("{}"), { gatewayUrl: GW, batchId: NULL_BATCH_ID, fetch: g.fetch });
    const ok = await g.fetch(`${GW}/bzz/${ref}/`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/json");
    expect(ok.headers.get("content-disposition")).toBe('inline; filename="transcript.json"');
    expect((await g.fetch(`${GW}/bzz/${ref}`)).status).toBe(302);
    expect((await g.fetch(`${GW}/bytes/${ref}`)).status).toBe(404);
  });

  it("a refusal, a dead gateway and an unreadable reply are SwarmGatewayErrors that name the cause", async () => {
    const g = fakeGateway();
    const o = { gatewayUrl: GW, batchId: NULL_BATCH_ID, fetch: g.fetch };
    g.state.status = 413;
    await expect(uploadBytes(new Uint8Array(1), o)).rejects.toMatchObject({ name: "SwarmGatewayError", status: 413, message: expect.stringContaining("HTTP 413") });
    g.state.status = 201;
    g.state.reply = "<html>busy</html>";
    await expect(uploadBytes(new Uint8Array(1), o)).rejects.toThrow(/unreadable reply/);
    g.state.reply = JSON.stringify({ reference: "nope" });
    await expect(uploadBytes(new Uint8Array(1), o)).rejects.toThrow(/no reference/);
    g.state.reply = null;
    g.state.down = true;
    const err = await uploadBytes(new Uint8Array(1), o).catch((e) => e);
    expect(err).toBeInstanceOf(SwarmGatewayError);
    expect(err.message).toMatch(/upload to https:\/\/gw.test failed: fetch failed/);
    await expect(downloadBytes("ab".repeat(32), o)).rejects.toBeInstanceOf(SwarmGatewayError);
  });

  it("a download of an unknown or malformed reference is null, without a request for the malformed one", async () => {
    const g = fakeGateway();
    expect(await downloadBytes("ab".repeat(32), { gatewayUrl: GW, fetch: g.fetch })).toBeNull();
    expect(g.gets()).toHaveLength(2); // the named file, then raw bytes
    expect(await downloadBytes("swarm-stub:abc", { gatewayUrl: GW, fetch: g.fetch })).toBeNull();
    expect(g.gets()).toHaveLength(2);
  });

  it("a refusal on the named-file read is an error, not a silent fall back to raw bytes", async () => {
    const f = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof globalThis.fetch;
    await expect(downloadBytes("ab".repeat(32), { gatewayUrl: GW, fetch: f })).rejects.toMatchObject({ name: "SwarmGatewayError", status: 502 });
  });
});

describe("configuration", () => {
  it("defaults to stub, the public gateway and the null stamp", () => {
    expect(swarmConfig({})).toMatchObject({ mode: "stub", gatewayUrl: PUBLIC_GATEWAY, batchId: NULL_BATCH_ID, secret: undefined, refused: undefined });
  });

  it("live needs a 32-byte secret, and never runs under the test runner", () => {
    expect(swarmConfig({ SWARM_MODE: "live" })).toMatchObject({ mode: "stub", refused: expect.stringContaining("SWARM_TRANSCRIPT_SECRET") });
    expect(swarmConfig({ SWARM_MODE: "live", SWARM_TRANSCRIPT_SECRET: "abc" }).mode).toBe("stub");
    expect(swarmConfig({ SWARM_MODE: "live", SWARM_TRANSCRIPT_SECRET: SECRET, VITEST: "true" })).toMatchObject({ mode: "stub", refused: expect.stringContaining("test runner") });
    expect(swarmConfig({ SWARM_MODE: "live", SWARM_TRANSCRIPT_SECRET: `0x${SECRET.toUpperCase()}`, SWARM_GATEWAY_URL: "http://localhost:1633/", SWARM_POSTAGE_BATCH_ID: "ab".repeat(32) })).toEqual({
      mode: "live",
      gatewayUrl: "http://localhost:1633",
      batchId: "ab".repeat(32),
      secret: SECRET,
      refused: undefined,
    });
    expect(swarmConfig({ SWARM_POSTAGE_BATCH_ID: "not-a-batch" }).batchId).toBe(NULL_BATCH_ID);
    expect(swarmConfig({ SWARM_MODE: "live", SWARM_TRANSCRIPT_SECRET: SECRET, SWARM_POSTAGE_BATCH_ID: "0xABC" })).toMatchObject({
      mode: "stub",
      refused: expect.stringContaining("SWARM_POSTAGE_BATCH_ID"),
    });
    for (const bad of ["localhost:1633", "ftp://x.test", "not a url"]) {
      expect(swarmConfig({ SWARM_MODE: "live", SWARM_TRANSCRIPT_SECRET: SECRET, SWARM_GATEWAY_URL: bad })).toMatchObject({
        mode: "stub",
        gatewayUrl: PUBLIC_GATEWAY,
        refused: `SWARM_GATEWAY_URL is not an http(s) URL: ${JSON.stringify(bad)}`,
      });
    }
    expect(swarmConfig({ SWARM_MODE: "live", SWARM_TRANSCRIPT_SECRET: SECRET, SWARM_GATEWAY_URL: "  " }).gatewayUrl).toBe(PUBLIC_GATEWAY);
  });

  it("public links never point at the configured upload endpoint, and open the named file with its trailing slash", () => {
    const ref = "ab".repeat(32);
    expect(swarmLinks.open(ref)).toBe(`${PUBLIC_GATEWAY}/bzz/${ref}/`);
    expect(swarmLinks.limo(ref)).toBe(`https://bzz.limo/bzz/${ref}/`);
    expect(swarmLinks.bytes(ref)).toBe(`${PUBLIC_GATEWAY}/bytes/${ref}`);
  });

  describe("the default port under the test runner", () => {
    const saved = { mode: process.env.SWARM_MODE, secret: process.env.SWARM_TRANSCRIPT_SECRET };
    beforeEach(() => {
      freshFixtureDb();
      process.env.SWARM_MODE = "live";
      process.env.SWARM_TRANSCRIPT_SECRET = SECRET;
    });
    afterEach(() => {
      if (saved.mode === undefined) delete process.env.SWARM_MODE;
      else process.env.SWARM_MODE = saved.mode;
      if (saved.secret === undefined) delete process.env.SWARM_TRANSCRIPT_SECRET;
      else process.env.SWARM_TRANSCRIPT_SECRET = saved.secret;
    });

    it("stays the stand-in even with SWARM_MODE=live, and says why", async () => {
      const { ref } = await swarm.put(fx());
      expect(ref.startsWith(STUB_PREFIX)).toBe(true);
      expect((await swarm.get(ref))?.transcriptHash).toBe(fx().transcriptHash);
      expect(swarmStatus()).toMatch(/SWARM_MODE=live refused: the test runner never uploads/);
    });
  });
});

describe("the live port", () => {
  let g: ReturnType<typeof fakeGateway>;
  let clock: number;
  const port = (deps: { fetch?: typeof fetch; now?: () => number } = {}) => createSwarm(liveConfig(), { fetch: g.fetch, now: () => clock, ...deps }) as LiveSwarm;

  beforeEach(() => {
    freshFixtureDb();
    g = fakeGateway();
    clock = Date.parse("2026-11-07T12:00:00Z");
  });

  it("put seals, uploads, and records a bare Swarm reference the Arkiv entity can carry", async () => {
    const t = fx("siege_put", "Gatekeeper, this one is only ever sealed."); // its own JSON: the stand-in store is process-global
    const { ref } = await port().put(t);
    expect(ref).toMatch(HEX64);
    expect(swarmRefFor(t.siegeId)).toBe(ref);
    expect(uploadRow(t.siegeId)).toMatchObject({ ref, attempts: 0, uploadedAt: clock, transcriptHash: t.transcriptHash, format: "file" });
    expect(swarmPending(t.siegeId, clock)).toBeNull();
    expect(swarmLink(t.siegeId, ref)).toBe(`${PUBLIC_GATEWAY}/bzz/${ref}/`);
    const sent = g.posts()[0];
    expect(sent.url).toBe(`${GW}/bzz?name=transcript.json`);
    expect(sent.headers["content-type"]).toBe("application/json");
    expect(sent.headers["swarm-postage-batch-id"]).toBe(NULL_BATCH_ID);
    expect(Buffer.from(sent.body!).toString("utf8")).not.toContain("Gatekeeper");
    // No readable copy anywhere else: the stand-in store never saw it.
    expect(await createSwarm({ ...liveConfig(), mode: "stub" }).get(STUB_PREFIX + createHash("sha256").update(JSON.stringify(t)).digest("hex"))).toBeNull();
    // Another process (the Next server) reads it back from the gateway and decrypts it.
    const reader = port();
    expect(await reader.get(ref)).toEqual(t);
    expect(g.gets().map((c) => c.url)).toEqual([`${GW}/bzz/${ref}/`]);
  });

  it("a transcript uploaded as raw bytes before: still readable, linked as bytes, and moved to a named file in the next pass", async () => {
    const t = fx("siege_legacy");
    const body = envelopeBytes(sealTranscript(t, SECRET));
    // As it was before transcripts were named: raw bytes on the gateway, format "bytes" in the store.
    const old = g.seedBytes(new Uint8Array(body));
    rememberUpload(t.siegeId, body, t.transcriptHash, clock);
    markUploaded(t.siegeId, old, clock);
    rawSqlite("SELECT 1").prepare("UPDATE swarm_uploads SET format = 'bytes' WHERE siege_id = ?").run(t.siegeId);
    recordSwarmRef(t.siegeId, old);
    expect(swarmLink(t.siegeId, old)).toBe(`${PUBLIC_GATEWAY}/bytes/${old}`);
    expect(await port().get(old)).toEqual(t);

    // Due at once, ahead of the 12-hour schedule: re-uploaded as transcript.json, a new reference.
    const p = port();
    clock += 61_000;
    const pass = await p.tick(clock);
    expect(pass.refreshed).toHaveLength(1);
    const moved = pass.refreshed[0];
    expect(moved).toMatchObject({ siegeId: t.siegeId, was: old });
    expect(moved.ref).not.toBe(old);
    expect(uploadRow(t.siegeId)).toMatchObject({ ref: moved.ref, format: "file" });
    expect(swarmRefFor(t.siegeId)).toBe(moved.ref);
    expect(swarmLink(t.siegeId, moved.ref)).toBe(`${PUBLIC_GATEWAY}/bzz/${moved.ref}/`);
    expect(await port().get(moved.ref)).toEqual(t);
    // Not again: it is a named file now.
    clock += 61_000;
    expect((await p.tick(clock)).refreshed).toEqual([]);
  });

  it("get: a stand-in ref still reads the local store; junk, an unknown reference and a dead gateway are null", async () => {
    const p = port();
    const stub = await createSwarm({ ...liveConfig(), mode: "stub" }).put(fx("siege_old"));
    expect(await p.get(stub.ref)).toEqual(fx("siege_old"));
    expect(await p.get("swarm-stub:" + "f".repeat(64))).toBeNull();
    expect(await p.get("not a reference")).toBeNull();
    expect(await p.get("ab".repeat(32))).toBeNull();
    g.state.down = true;
    expect(await p.get("ab".repeat(32))).toBeNull();
  });

  it("get: bytes that are not a sealed transcript, or sealed under another secret, are null", async () => {
    const other = createSwarm(liveConfig({ secret: "22".repeat(32) }), { fetch: g.fetch, now: () => clock }) as LiveSwarm;
    const { ref } = await other.put(fx());
    expect(await port().get(ref)).toBeNull();
    const plain = await uploadBytes(Buffer.from(JSON.stringify(fx())), { gatewayUrl: GW, batchId: NULL_BATCH_ID, fetch: g.fetch });
    expect(await port().get(plain)).toBeNull();
  });

  it("a gateway that is down at siege end: a pending reference, the transcript still readable, and the worker lands it later", async () => {
    const t = fx();
    const p = port();
    g.state.down = true;
    const { ref } = await p.put(t);
    expect(ref).toBe(PENDING_PREFIX + t.siegeId);
    expect(swarmRefFor(t.siegeId)).toBeUndefined();
    expect(swarmPending(t.siegeId, clock)).toBe("stranded"); // no worker has made a pass yet
    expect(uploadRow(t.siegeId)).toMatchObject({ ref: null, attempts: 1, lastError: expect.stringContaining("fetch failed") });
    expect(await p.get(ref)).toEqual(t);
    expect(p.copy(t.siegeId)).toEqual(t);
    expect(p.copy("siege_nobody")).toBeNull();

    // Backoff: one minute after the first failure, then doubling.
    g.state.down = false;
    clock += 30_000;
    expect(await p.tick(clock)).toEqual({ uploaded: [], refreshed: [], errors: [] });
    expect(g.posts()).toHaveLength(0);
    expect(swarmPending(t.siegeId, clock)).toBe("pending"); // the pass left the worker's heartbeat
    clock += 31_000;
    const pass = await p.tick(clock);
    expect(pass.uploaded).toHaveLength(1);
    expect(g.posts()).toHaveLength(1);
    const landed = swarmRefFor(t.siegeId)!;
    expect(landed).toMatch(HEX64);
    expect(pass.uploaded[0]).toEqual({ siegeId: t.siegeId, ref: landed });
    expect(swarmPending(t.siegeId, clock)).toBeNull();
    expect(uploadRow(t.siegeId)).toMatchObject({ ref: landed, attempts: 0, lastError: null, uploadedAt: clock });
    expect(await port().get(landed)).toEqual(t);
  });

  it("a failure during retry doubles the wait and keeps the error", async () => {
    const t = fx();
    const p = port();
    g.state.status = 503;
    await p.put(t);
    clock += 61_000;
    const pass = await p.tick(clock);
    expect(pass.errors).toEqual([`${t.siegeId}: upload to ${GW} refused: HTTP 503 {"code":503,"message":"payload too large"}`]);
    expect(uploadRow(t.siegeId)?.attempts).toBe(2);
    clock += 119_000; // 2 min minus a second: not yet
    expect((await p.tick(clock)).errors).toEqual([]);
    clock += 2_000;
    expect((await p.tick(clock)).errors).toHaveLength(1);
    expect(uploadRow(t.siegeId)?.attempts).toBe(3);
  });

  it("keep-alive: every transcript from the last week is re-uploaded twice a day and lands on the same reference", async () => {
    const t = fx();
    const p = port();
    const { ref } = await p.put(t);
    clock += KEEP_ALIVE_MS - 60_000;
    expect((await p.tick(clock)).refreshed).toEqual([]);
    clock += 120_000;
    const pass = await p.tick(clock);
    expect(pass.refreshed).toEqual([{ siegeId: t.siegeId, ref, was: ref }]);
    expect(g.posts()).toHaveLength(2);
    expect(uploadRow(t.siegeId)?.uploadedAt).toBe(clock);
    expect(swarmRefFor(t.siegeId)).toBe(ref);
    // Not again until another half day has passed.
    clock += 60_000;
    expect((await p.tick(clock)).refreshed).toEqual([]);
  });

  it("keep-alive: a transcript older than a week is left to lapse; a gateway outage is reported, not fatal", async () => {
    const t = fx();
    const p = port();
    await p.put(t);
    clock += 8 * DAY;
    expect((await p.tick(clock)).refreshed).toEqual([]);
    const fresh = fx("siege_fresh");
    await p.put(fresh);
    clock += KEEP_ALIVE_MS + 1;
    g.state.down = true;
    const pass = await p.tick(clock);
    expect(pass.refreshed).toEqual([]);
    expect(pass.errors).toEqual([`${fresh.siegeId}: keep-alive upload to ${GW} failed: fetch failed`]);
    expect(swarmRefFor(fresh.siegeId)).toMatch(HEX64); // the old reference stands
    expect(uploadRow(fresh.siegeId)).toMatchObject({ attempts: 1, lastError: `keep-alive upload to ${GW} failed: fetch failed` });
    // Backoff applies to keep-alive too; then it lands.
    g.state.down = false;
    clock += 30_000;
    expect((await p.tick(clock)).refreshed).toEqual([]);
    clock += 31_000;
    expect((await p.tick(clock)).refreshed).toHaveLength(1);
    expect(uploadRow(fresh.siegeId)).toMatchObject({ attempts: 0, lastError: null, uploadedAt: clock });
  });

  it("a dead gateway stops a pass after three failures instead of timing out on every row", async () => {
    const p = port();
    for (let i = 0; i < 6; i++) await p.put(fx(`siege_${i}`));
    clock += KEEP_ALIVE_MS + 1;
    g.state.down = true;
    const pass = await p.tick(clock);
    expect(pass.errors).toHaveLength(4);
    expect(pass.errors[3]).toBe("3 failures in a row: the gateway is not answering, stopping this pass");
    const tried = [0, 1, 2, 3, 4, 5].map((i) => uploadRow(`siege_${i}`)!.attempts);
    expect(tried.filter((a) => a === 1)).toHaveLength(3);
    expect(tried.filter((a) => a === 0)).toHaveLength(3);
  });

  it("a reference the gateway could not serve is not asked for again for half a minute", async () => {
    const p = port();
    const ref = "ab".repeat(32);
    expect(await p.get(ref)).toBeNull();
    expect(await p.get(ref)).toBeNull();
    expect(g.gets()).toHaveLength(2); // one miss: the named file, then raw bytes
    clock += 31_000;
    await p.get(ref);
    expect(g.gets()).toHaveLength(4);
  });

  it("a body that fails mid-stream is a SwarmGatewayError, so get() answers null instead of throwing", async () => {
    const broken = (async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.error(new Error("connection reset"));
          },
        }),
      )) as unknown as typeof globalThis.fetch;
    await expect(downloadBytes("ab".repeat(32), { gatewayUrl: GW, fetch: broken })).rejects.toMatchObject({ name: "SwarmGatewayError", message: expect.stringContaining("connection reset") });
    const p = createSwarm(liveConfig(), { fetch: broken, now: () => clock }) as LiveSwarm;
    expect(await p.get("ab".repeat(32))).toBeNull();
  });

  it("a replay whose reference Swarm stopped serving opens the sealed copy and asks the worker to put it back", async () => {
    const p = port();
    const t = fx();
    const { ref } = await p.put(t);
    g.files.clear(); // the gateway's stamp lapsed
    expect(await port().get(ref)).toBeNull();
    expect(p.copy(t.siegeId)).toEqual(t);
    // Even past the week horizon: the flag beats the schedule.
    clock += 8 * DAY;
    requestReupload(t.siegeId);
    const pass = await p.tick(clock);
    expect(pass.refreshed).toEqual([{ siegeId: t.siegeId, ref, was: ref }]);
    expect(uploadRow(t.siegeId)).toMatchObject({ needsReupload: false, uploadedAt: clock, createdAt: clock - 8 * DAY });
    expect(await port().get(ref)).toEqual(t);
    // Page views while the gateway is down do not reset the worker's backoff.
    g.files.clear();
    g.state.down = true;
    requestReupload(t.siegeId);
    clock += 61_000; // a minute's gap after any upload, success or not
    expect((await p.tick(clock)).errors).toHaveLength(1);
    expect(uploadRow(t.siegeId)?.attempts).toBe(1);
    // The flag is still up after the failure: further page views write nothing.
    expect(requestReupload(t.siegeId)).toBe(false);
    expect(requestReupload(t.siegeId)).toBe(false);
    clock += 30_000;
    expect((await p.tick(clock)).errors).toEqual([]); // still backing off
    expect(uploadRow(t.siegeId)).toMatchObject({ attempts: 1, needsReupload: true });
    // A row that never landed, or no row: nothing to flag.
    expect(requestReupload("siege_nobody")).toBe(false);
  });

  it("an op whose exact transcript already landed is not uploaded again inline, and its reference is repaired", async () => {
    const p = port();
    const a = await p.put(fx());
    g.state.down = true;
    forgetSwarmRef("siege_t1");
    const b = await p.put(fx());
    expect(b.ref).toBe(a.ref);
    expect(uploadRow("siege_t1")).toMatchObject({ ref: a.ref, attempts: 0, lastError: null });
    expect(swarmRefFor("siege_t1")).toBe(a.ref);
  });

  it("a different transcript for the same siege that fails to land leaves no stale reference behind", async () => {
    const p = port();
    const a = await p.put(fx("s", "first"));
    expect(swarmRefFor("s")).toBe(a.ref);
    g.state.down = true;
    const b = await p.put(fx("s", "second"));
    expect(b.ref).toBe(`${PENDING_PREFIX}s`);
    expect(swarmRefFor("s")).toBeUndefined();
    expect(await p.get(b.ref)).toEqual(fx("s", "second"));
  });

  it("the op-ending request gets a short upload budget; the worker gets the full one", async () => {
    const timeouts: number[] = [];
    const slow = (async (_input: string | URL | Request, init?: RequestInit) => {
      timeouts.push((init?.signal as { __ms?: number } | undefined)?.__ms ?? -1);
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    const realTimeout = AbortSignal.timeout;
    AbortSignal.timeout = (ms: number) => Object.assign(realTimeout(ms), { __ms: ms });
    try {
      const p = createSwarm(liveConfig(), { fetch: slow, now: () => clock }) as LiveSwarm;
      await p.put(fx());
      clock += 61_000;
      await p.tick(clock);
    } finally {
      AbortSignal.timeout = realTimeout;
    }
    expect(timeouts).toEqual([INLINE_TIMEOUT_MS, 10_000]);
    expect(INLINE_TIMEOUT_MS).toBeLessThanOrEqual(2_500);
  });

  it("a fresh upload is not trusted as a read: the first get downloads it, later ones use the cache", async () => {
    const p = port();
    const { ref } = await p.put(fx());
    expect(g.gets()).toHaveLength(0);
    expect(await p.get(ref)).toEqual(fx());
    expect(g.gets()).toHaveLength(1);
    expect(await p.get(ref)).toEqual(fx());
    expect(g.gets()).toHaveLength(1);
    // Ten minutes on, "read from Swarm" is proven again.
    clock += 10 * 60_000 + 1;
    await p.get(ref);
    expect(g.gets()).toHaveLength(2);
  });

  it("the read cache holds a bounded number of transcripts", async () => {
    const p = port();
    const refs: string[] = [];
    for (let i = 0; i < 65; i++) refs.push((await p.put(fx(`siege_${i}`))).ref);
    for (const r of refs) await p.get(r);
    expect(g.gets()).toHaveLength(65);
    await p.get(refs[64]); // still cached
    expect(g.gets()).toHaveLength(65);
    await p.get(refs[0]); // evicted: read from the gateway again
    expect(g.gets()).toHaveLength(66);
  });

  it("a different transcript for the same siege replaces the reference; the same one keeps it", async () => {
    const p = port();
    const a = await p.put(fx("s", "first"));
    const b = await p.put(fx("s", "second"));
    expect(b.ref).not.toBe(a.ref);
    expect(swarmRefFor("s")).toBe(b.ref);
    expect(uploadRow("s")).toMatchObject({ ref: b.ref, transcriptHash: fx("s", "second").transcriptHash });
    const again = await p.put(fx("s", "second"));
    expect(again.ref).toBe(b.ref);
    expect(g.posts()).toHaveLength(2); // nothing to upload the third time
  });
});

describe("the app's port with a test gateway (setLiveSwarmForTests)", () => {
  let g: ReturnType<typeof fakeGateway>;
  beforeEach(() => {
    freshFixtureDb();
    g = fakeGateway();
    setLiveSwarmForTests(createSwarm(liveConfig(), { fetch: g.fetch }) as LiveSwarm);
  });
  afterEach(() => setLiveSwarmForTests(null));

  it("swarm.put / swarm.get go through the live port; sealedCopy opens the kept bytes and flags them once", async () => {
    expect(isSwarmLive()).toBe(true);
    const t = fx("siege_app");
    const { ref } = await swarm.put(t);
    expect(ref).toMatch(HEX64);
    expect(await swarm.get(ref)).toEqual(t);
    expect(sealedCopy("siege_app")).toEqual(t);
    expect(uploadRow("siege_app")?.needsReupload).toBe(true);
    expect(sealedCopy("siege_nobody")).toBeNull();
  });

  it("is refused outside the test runner, and undone by null", () => {
    const vitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      expect(() => setLiveSwarmForTests(null)).toThrow(/test runner only/);
    } finally {
      process.env.VITEST = vitest;
    }
    setLiveSwarmForTests(null);
    expect(isSwarmLive()).toBe(false);
    expect(sealedCopy("anything")).toBeNull();
  });
});
