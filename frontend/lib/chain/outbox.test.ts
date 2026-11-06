import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { asc, eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, openDb, openTestDb, schema, type DB } from "@/lib/db";
import { emit } from "@/lib/events/bus";
import type { SiegeEvent } from "@/lib/types";
import { chain } from "./index";
import { drainAudit, enqueueAudit, IN_DOUBT_MS, STUB_IN_FLIGHT_MS, stubHcs, stubTopicId, txValidStartMs, type HcsLookup, type HcsPort } from "./outbox";

const L = schema.auditLog;
const at = () => new Date().toISOString();
const T1 = "0.0.7001";
const T2 = "0.0.7002";

function castle(d: DB, id: string, topicId: string | null) {
  d.insert(schema.castles)
    .values({
      id,
      name: id,
      guardianName: "Bram",
      tier: "wooden",
      orders: "SECRET",
      feeTinybar: 1,
      potTinybar: 1,
      owner: "0.0.1001",
      vaultState: "guarding",
      topicId,
      deadline: Date.now() + 86_400_000,
      createdAt: at(),
    })
    .run();
}

const ev = (castleId: string, i: number): SiegeEvent => ({ siegeId: `s_${castleId}`, castleId, type: "attempt", payload: { txId: `0xtx${i}` }, at: at() });

/** A fake HCS: per-topic sequence numbers, scripted failures, and a log of every send. */
function fakeHcs(script: { fail?: (topicId: string, txId: string, n: number) => Error | null; lookup?: (txId: string) => HcsLookup } = {}) {
  const seqs = new Map<string, number>();
  const landed = new Map<string, { topicId: string; seq: number }>();
  const sent: { topicId: string; localTx: string; message: string }[] = [];
  let nTx = 0;
  let clock = 1_800_000_000;
  const port: HcsPort = {
    newTxId: () => `0.0.2@${clock}.${String(++nTx).padStart(9, "0")}`,
    async submit(topicId, message, txId) {
      sent.push({ topicId, localTx: txId, message });
      const e = script.fail?.(topicId, txId, sent.length);
      if (e) throw e;
      const seq = (seqs.get(topicId) ?? 0) + 1;
      seqs.set(topicId, seq);
      landed.set(txId, { topicId, seq });
      return { seq, txId };
    },
    async lookup(txId) {
      if (script.lookup) return script.lookup(txId);
      const l = landed.get(txId);
      return l ? { state: "landed", seq: l.seq } : { state: "unknown" };
    },
  };
  return { port, sent, seqs, landed, tick: (s: number) => (clock += s) };
}

const notSent = (m: string) => Object.assign(new Error(m), { inDoubt: false });
const rows = (d: DB, topicId: string) => d.select().from(L).where(eq(L.topicId, topicId)).orderBy(asc(L.localSeq)).all();
const order = (d: DB, topicId: string) => rows(d, topicId).map((r) => JSON.parse(r.message).txId as string);

describe("audit outbox", () => {
  let d: DB;
  beforeEach(() => {
    d = openTestDb();
    castle(d, "c1", T1);
    castle(d, "c2", T2);
  });

  it("chain.audit only queues: local seq per topic, nothing sent, same message JSON", async () => {
    const r1 = await chain.audit(ev("c1", 1));
    const r2 = await chain.audit(ev("c1", 2));
    const r3 = await chain.audit(ev("c2", 3));
    expect([r1, r2, r3]).toEqual([
      { ok: true, topicId: T1, seq: 1 },
      { ok: true, topicId: T1, seq: 2 },
      { ok: true, topicId: T2, seq: 1 },
    ]);
    const r = rows(d, T1);
    expect(r.map((x) => [x.localSeq, x.state, x.seq, x.txId])).toEqual([
      [1, "pending", null, null],
      [2, "pending", null, null],
    ]);
    expect(JSON.parse(r[0].message)).toMatchObject({ v: 1, type: "siege.attempt", siegeId: "s_c1", castleId: "c1", txId: "0xtx1" });
  });

  it("drains each topic strictly in local order and records the HCS seq + tx id", async () => {
    for (let i = 1; i <= 4; i++) enqueueAudit(d, ev("c1", i), "testnet");
    const h = fakeHcs();
    const rep = await drainAudit({ db: () => d, mode: "testnet", port: h.port });
    expect(rep.submitted.map((s) => s.localSeq)).toEqual([1, 2, 3, 4]);
    expect(h.sent.map((s) => JSON.parse(s.message).txId)).toEqual(["0xtx1", "0xtx2", "0xtx3", "0xtx4"]);
    const r = rows(d, T1);
    expect(r.map((x) => [x.state, x.seq])).toEqual([1, 2, 3, 4].map((n) => ["submitted", n]));
    expect(r.every((x) => x.txId?.startsWith("0.0.2@") && x.submittedAt && x.attempts === 1)).toBe(true);
    // Nothing left: a second pass sends nothing.
    expect((await drainAudit({ db: () => d, mode: "testnet", port: h.port })).submitted).toEqual([]);
  });

  it("a failed submit stops its topic for the pass; the retry resends it first, so the order holds", async () => {
    for (let i = 1; i <= 3; i++) enqueueAudit(d, ev("c1", i), "testnet");
    let failOnce = true;
    const h = fakeHcs({
      fail: (_t, _tx, n) => {
        if (n === 2 && failOnce) {
          failOnce = false;
          return notSent("BUSY");
        }
        return null;
      },
    });
    const p1 = await drainAudit({ db: () => d, mode: "testnet", port: h.port });
    expect(p1.submitted.map((s) => s.localSeq)).toEqual([1]);
    expect(p1.failed).toMatchObject([{ topicId: T1, localSeq: 2, error: "BUSY" }]);
    expect(rows(d, T1).map((x) => [x.state, x.lastError])).toEqual([
      ["submitted", null],
      ["pending", "BUSY"],
      ["pending", null],
    ]);
    // A row appended meanwhile goes after the queued ones.
    enqueueAudit(d, ev("c1", 4), "testnet");
    const p2 = await drainAudit({ db: () => d, mode: "testnet", port: h.port });
    expect(p2.submitted.map((s) => s.localSeq)).toEqual([2, 3, 4]);
    expect(h.sent.map((s) => JSON.parse(s.message).txId)).toEqual(["0xtx1", "0xtx2", "0xtx2", "0xtx3", "0xtx4"]);
    expect(rows(d, T1).map((x) => x.seq)).toEqual([1, 2, 3, 4]);
    expect(order(d, T1)).toEqual(["0xtx1", "0xtx2", "0xtx3", "0xtx4"]);
  });

  it("an in-doubt submit is looked up before anything else on its topic: landed -> recorded once, never resent", async () => {
    for (let i = 1; i <= 3; i++) enqueueAudit(d, ev("c1", i), "testnet");
    const lost = new Set<number>([2]);
    // Message 2 reaches consensus but the receipt times out.
    const h = fakeHcs();
    const submit = h.port.submit;
    h.port.submit = async (topicId, message, txId) => {
      const res = await submit(topicId, message, txId);
      if (lost.delete(h.sent.length)) throw new Error("receipt timeout");
      return res;
    };
    const lookups: string[] = [];
    let mirrorCaughtUp = false;
    const lookup = h.port.lookup;
    h.port.lookup = async (txId) => {
      lookups.push(txId);
      return mirrorCaughtUp ? lookup(txId) : { state: "unknown" };
    };
    const now = () => txValidStartMs(h.port.newTxId()) + 1000;
    const p1 = await drainAudit({ db: () => d, mode: "testnet", port: h.port, now });
    expect(p1.submitted.map((s) => s.localSeq)).toEqual([1]);
    const doubtful = rows(d, T1)[1];
    expect(doubtful.state).toBe("submitting");
    expect(doubtful.txId).toBeTruthy();
    // The mirror has not seen it yet: wait, send nothing on this topic (message 3 must not overtake it).
    const p2 = await drainAudit({ db: () => d, mode: "testnet", port: h.port, now });
    expect(p2.waiting).toEqual([T1]);
    expect(h.sent).toHaveLength(2);
    mirrorCaughtUp = true;
    const p3 = await drainAudit({ db: () => d, mode: "testnet", port: h.port, now });
    expect(p3.submitted.map((s) => [s.localSeq, s.seq])).toEqual([
      [2, 2],
      [3, 3],
    ]);
    expect(lookups).toEqual([doubtful.txId, doubtful.txId]);
    expect(h.sent).toHaveLength(3); // message 2 was sent once
    expect(rows(d, T1).map((x) => [x.state, x.seq, x.txId === null])).toEqual([
      ["submitted", 1, false],
      ["submitted", 2, false],
      ["submitted", 3, false],
    ]);
    expect(rows(d, T1)[1].txId).toBe(doubtful.txId);
  });

  it("an in-doubt submit the mirror never saw is resent under a new tx id once it can no longer land", async () => {
    enqueueAudit(d, ev("c1", 1), "testnet");
    enqueueAudit(d, ev("c1", 2), "testnet");
    let drop = true;
    const h = fakeHcs({ lookup: () => ({ state: "unknown" }) });
    const submit = h.port.submit;
    h.port.submit = async (topicId, message, txId) => {
      if (drop) {
        drop = false;
        h.sent.push({ topicId, localTx: txId, message });
        throw new Error("UNAVAILABLE: connection reset");
      }
      return submit(topicId, message, txId);
    };
    let t = 0;
    const now = () => t;
    t = txValidStartMs(h.port.newTxId()) + 5_000;
    await drainAudit({ db: () => d, mode: "testnet", port: h.port, now });
    const first = rows(d, T1)[0];
    expect([first.state, first.lastError]).toEqual(["submitting", "UNAVAILABLE: connection reset"]);
    await drainAudit({ db: () => d, mode: "testnet", port: h.port, now });
    expect(rows(d, T1)[0].state).toBe("submitting");
    t += IN_DOUBT_MS;
    const p = await drainAudit({ db: () => d, mode: "testnet", port: h.port, now });
    expect(p.submitted.map((s) => s.localSeq)).toEqual([1, 2]);
    const r = rows(d, T1);
    expect(r[0].txId).not.toBe(first.txId);
    expect(r[0].attempts).toBe(2);
    expect(r.map((x) => x.seq)).toEqual([1, 2]);
  });

  it("one failing topic does not hold up another", async () => {
    for (let i = 1; i <= 3; i++) {
      enqueueAudit(d, ev("c1", i), "testnet");
      enqueueAudit(d, ev("c2", 10 + i), "testnet");
    }
    const h = fakeHcs({ fail: (topicId) => (topicId === T1 ? notSent("INVALID_TOPIC_ID") : null) });
    const rep = await drainAudit({ db: () => d, mode: "testnet", port: h.port });
    expect(rep.failed).toMatchObject([{ topicId: T1, localSeq: 1 }]);
    expect(rows(d, T1).every((x) => x.state === "pending")).toBe(true);
    expect(rows(d, T2).map((x) => [x.state, x.seq])).toEqual([1, 2, 3].map((n) => ["submitted", n]));
    expect(order(d, T2)).toEqual(["0xtx11", "0xtx12", "0xtx13"]);
    // T1 only ever tried its first row.
    expect(h.sent.filter((s) => s.topicId === T1).map((s) => JSON.parse(s.message).txId)).toEqual(["0xtx1"]);
  });

  it("a row a pre-outbox writer added (no local_seq) never blocks its topic: it is settled as submitted/skipped, not resent", async () => {
    enqueueAudit(d, ev("c1", 1), "testnet");
    // The old inline writer's column list: no local_seq, state defaults to "pending".
    d.run(sql`INSERT INTO audit_log (topic_id, castle_id, siege_id, type, message, seq, tx_id, at) VALUES (${T1}, 'c1', 's', 'siege.attempt', '{"old":1}', 999, '0.0.2@1.1', 'now')`);
    d.run(sql`INSERT INTO audit_log (topic_id, castle_id, siege_id, type, message, seq, tx_id, at) VALUES (${T1}, 'c1', 's', 'siege.attempt', '{"old":2}', NULL, NULL, 'now')`);
    enqueueAudit(d, ev("c1", 2), "testnet");
    const h = fakeHcs();
    const rep = await drainAudit({ db: () => d, mode: "testnet", port: h.port });
    expect(rep.repaired).toBe(2);
    expect(rep.submitted.map((x) => x.localSeq)).toEqual([1, 2]);
    expect(h.sent.map((x) => JSON.parse(x.message).txId)).toEqual(["0xtx1", "0xtx2"]);
    const legacy = d.select().from(L).where(sql`${L.localSeq} IS NULL`).orderBy(asc(L.id)).all();
    expect(legacy.map((x) => [x.state, x.seq, x.lastError])).toEqual([
      ["submitted", 999, "legacy_writer"],
      ["skipped", null, "legacy_writer"],
    ]);
    expect((await drainAudit({ db: () => d, mode: "testnet", port: h.port })).repaired).toBe(0);
  });

  it("a slow topic does not hold up the others: the pass returns, later passes serve the rest, and the slow one is never sent twice", async () => {
    for (let i = 1; i <= 2; i++) {
      enqueueAudit(d, ev("c1", i), "testnet");
      enqueueAudit(d, ev("c2", 10 + i), "testnet");
    }
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = fakeHcs();
    const submit = h.port.submit;
    let t1Sends = 0;
    h.port.submit = async (topicId, message, txId) => {
      if (topicId === T1) {
        t1Sends++;
        await gate; // hangs like a submit waiting out the SDK request timeout
      }
      return submit(topicId, message, txId);
    };
    const p1 = await drainAudit({ db: () => d, mode: "testnet", port: h.port, waitMs: 30 });
    expect(p1.submitted.map((x) => x.topicId)).toEqual([T2, T2]);
    enqueueAudit(d, ev("c2", 13), "testnet");
    const p2 = await drainAudit({ db: () => d, mode: "testnet", port: h.port, waitMs: 30 });
    expect(p2.submitted.map((x) => [x.topicId, x.localSeq])).toEqual([[T2, 3]]);
    expect(t1Sends).toBe(1); // still in flight: not started again
    release();
    const p3 = await drainAudit({ db: () => d, mode: "testnet", port: h.port });
    expect(p3.submitted.map((x) => [x.topicId, x.localSeq])).toEqual([
      [T1, 1],
      [T1, 2],
    ]);
    expect(t1Sends).toBe(2);
    expect(order(d, T1)).toEqual(["0xtx1", "0xtx2"]);
  });

  it("a topic that throws outside its submit (e.g. newTxId) is reported and retried; the others still drain", async () => {
    enqueueAudit(d, ev("c1", 1), "testnet");
    enqueueAudit(d, ev("c2", 11), "testnet");
    const h = fakeHcs();
    const newTxId = h.port.newTxId;
    let boom = true;
    h.port.newTxId = () => {
      if (boom) {
        boom = false;
        throw new Error("SQLITE_BUSY");
      }
      return newTxId();
    };
    const p1 = await drainAudit({ db: () => d, mode: "testnet", port: h.port });
    expect(p1.failed).toMatchObject([{ type: "drain", error: "SQLITE_BUSY" }]);
    expect(p1.submitted).toHaveLength(1);
    const p2 = await drainAudit({ db: () => d, mode: "testnet", port: h.port });
    expect(p2.submitted).toHaveLength(1);
    expect([...rows(d, T1), ...rows(d, T2)].every((x) => x.state === "submitted")).toBe(true);
  });

  it("stub HCS: a row another drainer is sending right now is waited for, an abandoned one is resent", async () => {
    let clock = 1_800_000_000_000;
    const port = stubHcs(() => d, () => clock);
    const txId = port.newTxId();
    expect(txId).toMatch(/^stub:hcs@1800000000\.\d{9}$/);
    expect(await port.lookup(txId)).toEqual({ state: "unknown" });
    clock += STUB_IN_FLIGHT_MS + 1_000;
    expect(await port.lookup(txId)).toEqual({ state: "failed", reason: "stub_not_sent" });

    // A row claimed a moment ago by another stub drainer: this one waits instead of resending it.
    castle(d, "c7", null);
    enqueueAudit(d, ev("c7", 1), "stub");
    const fresh = `stub:hcs@${Math.floor(Date.now() / 1000)}.000000001`;
    d.update(L).set({ state: "submitting", txId: fresh }).where(eq(L.topicId, stubTopicId("c7"))).run();
    const rep = await drainAudit({ db: () => d, mode: "stub" });
    expect(rep.waiting).toEqual([stubTopicId("c7")]);
    expect(rows(d, stubTopicId("c7"))[0].state).toBe("submitting");
    // Long abandoned (a crashed drainer): sent again.
    d.update(L).set({ txId: "stub:hcs@1700000000.000000001" }).where(eq(L.topicId, stubTopicId("c7"))).run();
    const rep2 = await drainAudit({ db: () => d, mode: "stub" });
    expect(rep2.submitted.map((x) => [x.localSeq, x.seq])).toEqual([[1, 1]]);
  });

  it("testnet: a castle without a topic is skipped (no_topic), and the drainer leaves stub topics alone", async () => {
    castle(d, "c3", null);
    expect(enqueueAudit(d, ev("c3", 1), "testnet")).toEqual({ ok: false, reason: "no_topic" });
    expect(d.select().from(L).where(eq(L.castleId, "c3")).get()).toMatchObject({ topicId: "none", state: "skipped" });
    castle(d, "c4", "0.0.stub-c4");
    enqueueAudit(d, ev("c4", 1), "testnet");
    const h = fakeHcs();
    await drainAudit({ db: () => d, mode: "testnet", port: h.port });
    expect(h.sent).toEqual([]);
    expect(rows(d, "0.0.stub-c4")[0].state).toBe("pending");
  });

  it("stub mode drains the same way, with stub sequence numbers and no network; real topics are left alone", async () => {
    castle(d, "c5", null);
    for (let i = 1; i <= 3; i++) expect(enqueueAudit(d, ev("c5", i), "stub")).toEqual({ ok: true, topicId: stubTopicId("c5"), seq: i });
    enqueueAudit(d, ev("c1", 9), "stub"); // c1 has a real topic id: never stub-"submitted"
    const rep = await drainAudit({ db: () => d, mode: "stub" });
    expect(rep.submitted.map((s) => [s.localSeq, s.seq])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(rows(d, stubTopicId("c5")).map((x) => [x.state, x.seq, x.txId])).toEqual([1, 2, 3].map((n) => ["submitted", n, null]));
    expect(rows(d, T1)[0].state).toBe("pending");
  });

  it("siege.start / siege.message / siege.end come from the events table, in events order, once each", async () => {
    castle(d, "c6", null);
    const base = { siegeId: "s6", castleId: "c6", transport: "sdk" as const };
    emit({ ...base, type: "start", turn: 0, payload: { transport: "sdk", free: true, receipt: null, raider: "0.0.9" } });
    emit({ ...base, type: "message", turn: 1, requestId: "req-1", payload: { role: "raider", text: "hello", transport: "sdk", requestId: "req-1" } });
    emit({ ...base, type: "decision", turn: 1, requestId: "req-1", payload: { move: "refuse", reply: "no" } });
    emit({ ...base, type: "end", turn: 1, payload: { status: "held", transcriptHash: `0x${"11".repeat(32)}` } });
    const rep = await drainAudit({ db: () => d, mode: "stub" });
    expect(rep.derived).toBe(3);
    const r = rows(d, stubTopicId("c6")).map((x) => JSON.parse(x.message));
    expect(r.map((m) => m.type)).toEqual(["siege.start", "siege.message", "siege.end"]);
    expect(r[0]).toEqual({ v: 1, type: "siege.start", siegeId: "s6", castleId: "c6", transport: "sdk", at: r[0].at });
    expect(r[1]).toMatchObject({ turn: 1, transport: "sdk", requestId: "req-1" });
    expect(JSON.stringify(r)).not.toContain("hello");
    expect(r[2]).toMatchObject({ turn: 1, result: "held", hash: `0x${"11".repeat(32)}`, requestId: "req-1" });
    expect((await drainAudit({ db: () => d, mode: "stub" })).derived).toBe(0);
    expect(db().select().from(schema.auditMeta).get()).toMatchObject({ k: "events_cursor" });
  });
});

describe("migration 0005 on a DB with inline-era audit rows", () => {
  const dirs: string[] = [];
  afterEach(() => {
    // openDb() keeps the file it opened as the process-wide handle: close it before deleting its
    // directory, or Windows refuses (EPERM). The test reopens an in-memory DB itself; this covers a
    // failure before it gets there.
    const g = globalThis as unknown as { __siegeDb?: { sqlite: { close(): void }; url: string } };
    if (g.__siegeDb && g.__siegeDb.url !== ":memory:") {
      g.__siegeDb.sqlite.close();
      g.__siegeDb = undefined;
    }
    for (const x of dirs.splice(0)) rmSync(x, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it("marks sent rows submitted, failed ones skipped (never resent), numbers them, and starts derivation after the newest event", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "siege-audit-mig-"));
    dirs.push(dir);
    const file = path.join(dir, "siege.db");
    const s = new Database(file);
    const journal = JSON.parse(readFileSync(path.join(process.cwd(), "drizzle/meta/_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
    s.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)");
    for (const e of journal.entries.filter((e) => Number(e.tag.slice(0, 4)) < 5)) {
      for (const stmt of readFileSync(path.join(process.cwd(), "drizzle", `${e.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) s.exec(stmt);
      s.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(e.tag, e.when);
    }
    const ins = s.prepare("INSERT INTO audit_log (topic_id, castle_id, siege_id, type, message, seq, tx_id, at) VALUES (?, 'c', 's', 'siege.message', '{}', ?, ?, 'now')");
    ins.run("0.0.1", 1, "0.0.2@1.1");
    ins.run("0.0.1", null, null); // a failed inline submit
    ins.run("0.0.1", 2, "0.0.2@1.2");
    ins.run("none", null, null);
    for (let i = 0; i < 3; i++) s.prepare("INSERT INTO events (siege_id, castle_id, type, turn, payload, at) VALUES ('s', 'c', 'message', 1, '{}', 'now')").run();
    s.close();

    const migrated = openDb(file);
    const r = migrated.select().from(L).orderBy(asc(L.id)).all();
    expect(r.map((x) => [x.topicId, x.localSeq, x.state])).toEqual([
      ["0.0.1", 1, "submitted"],
      ["0.0.1", 2, "skipped"],
      ["0.0.1", 3, "submitted"],
      ["none", 1, "skipped"],
    ]);
    expect(migrated.select().from(schema.auditMeta).all()).toEqual([{ k: "events_cursor", v: "3" }]);
    // Already-audited events are not derived again; nothing old is resent.
    const rep = await drainAudit({ db: () => migrated, mode: "testnet", port: fakeHcs().port });
    expect(rep).toMatchObject({ derived: 0, submitted: [], failed: [] });
    // Close the file handle before swapping in the in-memory one (openTestDb drops it unclosed).
    (globalThis as unknown as { __siegeDb?: { sqlite: { close(): void } } }).__siegeDb?.sqlite.close();
    openTestDb();
  });
});
