/**
 * Ended ops whose transcript is on Swarm stay on Arkiv for a week (the public pointer to the
 * transcript); every other op keeps the 10-minute life. Covers the pure expiry rule and the real
 * drainer path against a fake Arkiv client (no chain is touched).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
process.env.SIEGE_FAST = "1";

const batches: Record<string, unknown[]>[] = [];
vi.mock("./client", () => ({
  arenaAddress: () => "0xA69d59B6d6e55Aa6da960405D4150ea59460bb18",
  arkivWriter: () => ({
    executeBatch: vi.fn(async (b: Record<string, unknown[]>) => {
      batches.push(b);
      return { txHash: `0xtx${batches.length}`, createdEntities: (b.creates ?? []).map((_, i) => `0xkey${batches.length}_${i}`) };
    }),
    deleteEntity: vi.fn(),
  }),
  // adopt(): nothing on chain yet.
  arkivReader: () => {
    const q = { select: () => q, from: () => q, where: () => q, ownedBy: () => q, limit: () => q, fetch: async () => ({ entities: [], blockNumber: 0n }) };
    return { ...q, getEntity: vi.fn() };
  },
}));

import { ExpirationTime } from "@arkiv-network/sdk";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { db } from "@/lib/db";
import { siege } from "@/lib/siege";
import { KEEP_ALIVE_HORIZON_MS } from "@/lib/swarm/live";
import type { Siege } from "@/lib/types";
import { OP_ARCHIVE_DAYS, OP_TTL_MIN, createLife, drain, enqueue, entityRecord, extendLife, isSwarmRef, opExpiry, outboxStats, payloadFingerprint } from "./outbox";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const REF = "1907b1c219d15cb938cd72434a226453db16bd6b5694d7ce581e330ecf5e10a9";
const STUB_REF = "swarm-stub:" + "ab".repeat(32);
const NOW = Date.parse("2026-11-07T12:00:00Z");

const raw = () => (db() as unknown as { $client: { prepare(s: string): { run(...a: unknown[]): unknown } } }).$client;
const at = (ms: number) => new Date(ms).toISOString();

let base: Siege;
const ended = (endMs: number, status: Siege["status"] = "held"): Siege => ({ ...base, status, endedAt: at(endMs) });
const live = (): Siege => ({ ...base, status: "in_progress", endedAt: undefined });

beforeEach(async () => {
  freshFixtureDb();
  batches.length = 0;
  base = await siege.start({ castleId: "castle_splinter_gate", raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
});

describe("op lifetime on Arkiv", () => {
  it("keeps the archive exactly as long as the Swarm worker keeps the transcript alive", () => {
    expect(OP_ARCHIVE_DAYS * DAY).toBe(KEEP_ALIVE_HORIZON_MS);
  });

  it("only a bare 64-hex reference counts as a transcript on Swarm", () => {
    expect(isSwarmRef(REF)).toBe(true);
    expect(isSwarmRef(REF.toUpperCase())).toBe(true);
    for (const bad of [undefined, "", STUB_REF, REF.slice(1), REF + "00", `${REF}/transcript.json`, "0x" + REF.slice(2)]) expect(isSwarmRef(bad)).toBe(false);
  });

  it("matrix: live, ended with and without a transcript on Swarm, stub reference, past the week", () => {
    const short = NOW + OP_TTL_MIN * MIN;
    // Live: 10 minutes, even with a reference (a live op has no final transcript).
    expect(opExpiry(live(), REF, NOW)).toEqual({ expiresAtMs: short, archived: false });
    // Ended with its transcript on Swarm: a week past the end.
    const end = NOW - 2 * MIN;
    expect(opExpiry(ended(end), REF, NOW)).toEqual({ expiresAtMs: end + 7 * DAY, archived: true });
    expect(opExpiry(ended(end, "broken"), REF, NOW)).toEqual({ expiresAtMs: end + 7 * DAY, archived: true });
    // Ended without one, or with the local stand-in's: 10 minutes.
    expect(opExpiry(ended(end), undefined, NOW)).toEqual({ expiresAtMs: short, archived: false });
    expect(opExpiry(ended(end), STUB_REF, NOW)).toEqual({ expiresAtMs: short, archived: false });
    // A reference that lands after the week (or in its last minutes): never shorter than 10 minutes.
    expect(opExpiry(ended(NOW - 8 * DAY), REF, NOW)).toEqual({ expiresAtMs: short, archived: false });
    expect(opExpiry(ended(NOW - 7 * DAY + 5 * MIN), REF, NOW)).toEqual({ expiresAtMs: short, archived: false });
    // A reference that lands late but inside the week: still a week from the end, not from now.
    expect(opExpiry(ended(NOW - 3 * DAY), REF, NOW)).toEqual({ expiresAtMs: NOW - 3 * DAY + 7 * DAY, archived: true });
    // An unreadable end time is treated as not ended.
    expect(opExpiry({ ...base, status: "held", endedAt: "not a date" }, REF, NOW)).toEqual({ expiresAtMs: short, archived: false });
  });

  it("create: a week as a deadline for an archived op, 10 minutes as a duration otherwise", () => {
    const end = NOW - MIN;
    const archived = createLife({ kind: "op", data: ended(end), swarmRef: REF }, NOW)!;
    expect(archived.expiresAtMs).toBe(end + 7 * DAY);
    expect(archived.expiration).toEqual(ExpirationTime.atDate(new Date(end + 7 * DAY)));
    const plain = createLife({ kind: "op", data: ended(end) }, NOW)!;
    expect(plain.expiration).toEqual(ExpirationTime.fromMinutes(OP_TTL_MIN));
    expect(plain.expiresAtMs).toBe(NOW + OP_TTL_MIN * MIN);
  });

  it("extend: the reference landing pushes a 10-minute op out to the week once, and never again", () => {
    const end = NOW - MIN;
    const p = { kind: "op" as const, data: ended(end), swarmRef: REF };
    const ext = extendLife(p, NOW + 9 * MIN, NOW)!;
    expect(ext.expiresAtMs).toBe(end + 7 * DAY);
    expect(ext.expiration).toEqual(ExpirationTime.atDate(new Date(end + 7 * DAY)));
    // Already archived: a later write (a status change, a new reference) does not extend again.
    expect(extendLife(p, end + 7 * DAY, NOW + DAY)).toBeNull();
    // An archived op re-written without a reference is never shortened (the chain refuses that).
    expect(extendLife({ kind: "op", data: ended(end) }, end + 7 * DAY, NOW)).toBeNull();
    // A live op: unchanged rule, refresh only when the new life is meaningfully later.
    expect(extendLife({ kind: "op", data: live() }, NOW + 9 * MIN + 45_000, NOW)).toBeNull();
    expect(extendLife({ kind: "op", data: live() }, NOW + 2 * MIN, NOW)!.expiration).toEqual(ExpirationTime.fromMinutes(OP_TTL_MIN));
  });
});

describe("the drainer keeps archived ops a week (fake Arkiv client)", () => {
  const record = (id: string, fp: string, expiresAtMs: number) => {
    outboxStats(); // creates the outbox tables
    raw().prepare("INSERT INTO arkiv_entities (kind, id, key, fingerprint, expires_at_ms, updated_at) VALUES ('op', ?, '0xop', ?, ?, 'now')").run(id, fp, expiresAtMs);
  };

  it("an op that ends with its transcript on Swarm is created with a week-long deadline and its reference", async () => {
    const end = Date.now() - MIN;
    expect(enqueue({ kind: "op", data: ended(end), swarmRef: REF }).queued).toBe(true);
    const r = await drain({ holder: "t" });
    expect(r.errors).toEqual([]);
    expect(batches).toHaveLength(1);
    const [create] = batches[0].creates as { values: Record<string, { value: unknown }>; expiration: unknown }[];
    expect(create.values.swarmRef.value).toBe(REF);
    expect(create.values.status.value).toBe("held");
    expect(create.expiration).toEqual(ExpirationTime.atDate(new Date(end + 7 * DAY)));
    expect(entityRecord("op", base.id)?.expiresAtMs).toBe(end + 7 * DAY);
  });

  it("an op without a transcript on Swarm keeps the 10-minute life (live, ended, stub reference)", async () => {
    for (const [data, ref] of [[live(), undefined], [ended(Date.now() - MIN), undefined], [ended(Date.now() - MIN), STUB_REF]] as const) {
      freshFixtureDb();
      batches.length = 0;
      enqueue({ kind: "op", data: { ...data, id: base.id }, swarmRef: ref });
      await drain({ holder: "t" });
      const [create] = batches[0].creates as { expiration: unknown }[];
      expect(create.expiration).toEqual(ExpirationTime.fromMinutes(OP_TTL_MIN));
      const rec = entityRecord("op", base.id)!;
      expect(rec.expiresAtMs - Date.now()).toBeLessThanOrEqual(OP_TTL_MIN * MIN);
      expect(rec.expiresAtMs - Date.now()).toBeGreaterThan(OP_TTL_MIN * MIN - MIN);
    }
  });

  it("a reference that lands after the op ended patches it in and extends the entity to the week", async () => {
    const end = Date.now() - 3 * MIN;
    const data = ended(end);
    // On Arkiv already: the ended op without a reference, 10 minutes of life left at most.
    record(base.id, payloadFingerprint({ kind: "op", data }), Date.now() + 7 * MIN);
    enqueue({ kind: "op", data, swarmRef: REF });
    const r = await drain({ holder: "t" });
    expect(r.errors).toEqual([]);
    const b = batches[0] as { creates: unknown[]; patches: { entityKey: string; set: Record<string, { value: unknown }> }[]; extensions: { entityKey: string; expiration: unknown }[] };
    expect(b.creates).toEqual([]);
    expect(b.patches).toHaveLength(1);
    expect(b.patches[0].set.swarmRef.value).toBe(REF);
    expect(b.extensions).toEqual([{ entityKey: "0xop", expiration: ExpirationTime.atDate(new Date(end + 7 * DAY)) }]);
    expect(entityRecord("op", base.id)?.expiresAtMs).toBe(end + 7 * DAY);
  });

  it("an archived op already holding these values sends nothing, even when forced", async () => {
    const end = Date.now() - 3 * MIN;
    const p = { kind: "op" as const, data: ended(end), swarmRef: REF };
    record(base.id, payloadFingerprint(p), end + 7 * DAY);
    expect(enqueue(p).queued).toBe(false);
    expect(enqueue(p, { force: true }).queued).toBe(true);
    const r = await drain({ holder: "t" });
    expect(r.skipped).toBe(1);
    expect(batches).toEqual([]);
  });
});
