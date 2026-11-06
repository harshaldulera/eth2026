import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { db, openTestDb, schema, type DB } from "@/lib/db";
import type { Verification } from "@/lib/types";
import { chain, chainInfo, prepareRelease } from "./index";
import { DEV_VERIFIER_KEY } from "./releaseSig";
import { createStubChain } from "./stub";

const B = (n: number | string) => BigInt(n);
const HASH = `0x${"cd".repeat(32)}` as `0x${string}`;
const FUTURE = Date.now() + 7 * 86_400_000;

let n = 0;
function seed(
  d: DB,
  o: { fee?: number; pot?: number; status?: "created" | "in_progress" | "held" | "broken" | "banished"; free?: boolean; deadline?: number; transcriptHash?: string | null; vaultId?: number | null } = {},
) {
  n++;
  const castleId = `castle_t${n}`;
  const siegeId = `siege_t${n}`;
  const fee = o.fee ?? 100_000_000;
  d.insert(schema.castles)
    .values({
      id: castleId,
      name: `Castle ${n}`,
      guardianName: "Old Bram",
      tier: "wooden",
      orders: "SECRET ORDERS",
      feeTinybar: fee,
      potTinybar: o.pot ?? 500_000_000,
      owner: "0.0.1001",
      vaultId: o.vaultId === undefined ? n : o.vaultId,
      deadline: o.deadline ?? FUTURE,
      createdAt: new Date().toISOString(),
    })
    .run();
  let receiptId: string | null = null;
  if (!o.free) {
    receiptId = `rcpt_t${n}`;
    d.insert(schema.paymentReceipts)
      .values({ id: receiptId, siegeId, payer: "0.0.2002", amountTinybar: fee, asset: "0.0.0", free: false, stub: true, createdAt: new Date().toISOString() })
      .run();
  }
  d.insert(schema.sieges)
    .values({
      id: siegeId,
      castleId,
      raider: "0.0.2002",
      free: o.free ?? false,
      status: o.status ?? "held",
      receiptId,
      transcriptHash: o.transcriptHash === undefined ? HASH : o.transcriptHash,
      createdAt: new Date().toISOString(),
    })
    .run();
  return { castleId, siegeId };
}

const verdict = (siegeId: string, signature: `0x${string}`): Verification & { signature: `0x${string}` } => ({
  siegeId,
  transcriptHash: HASH,
  requestId: "0g-stub-1",
  ok: true,
  signature,
});

describe("stub chain (isolated test db)", () => {
  let d: DB;
  let c: ReturnType<typeof createStubChain>;
  beforeEach(() => {
    d = openTestDb();
    c = createStubChain(() => d);
  });

  it("recordAttempt splits exactly like the contract and sums to the fee", async () => {
    const { siegeId } = seed(d, { fee: 100_000_000, pot: 500_000_000 });
    const r = await c.recordAttempt(siegeId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.split).toEqual({ castellan: "80000000", pot: "15000000", arena: "5000000" });
    expect(B(r.split.castellan) + B(r.split.pot) + B(r.split.arena)).toBe(B(100_000_000));
    expect(r.newPot).toBe("515000000");
    expect(r.tx.stub).toBe(true);
    expect(r.tx.txId).toMatch(/^stub:0\.0\.0@\d+\.\d+$/);
  });

  it("odd fees: pot absorbs rounding dust", async () => {
    const { siegeId } = seed(d, { fee: 33, pot: 1000 });
    const r = await c.recordAttempt(siegeId);
    if (!r.ok) throw new Error(r.reason);
    expect(r.split).toEqual({ castellan: "26", pot: "6", arena: "1" });
    expect(r.newPot).toBe("1006");
  });

  it("banished sieges are recorded too", async () => {
    const { siegeId } = seed(d, { status: "banished" });
    expect((await c.recordAttempt(siegeId)).ok).toBe(true);
  });

  it("recordAttempt refuses free, unfinished, recorded, expired, unknown sieges", async () => {
    expect(await c.recordAttempt(seed(d, { free: true }).siegeId)).toEqual({ ok: false, reason: "free_siege" });
    expect(await c.recordAttempt(seed(d, { status: "in_progress" }).siegeId)).toEqual({ ok: false, reason: "bad_status" });
    expect(await c.recordAttempt(seed(d, { status: "broken" }).siegeId)).toEqual({ ok: false, reason: "bad_status" });
    expect(await c.recordAttempt(seed(d, { deadline: Date.now() - 1000 }).siegeId)).toEqual({ ok: false, reason: "expired" });
    expect(await c.recordAttempt("siege_nope")).toEqual({ ok: false, reason: "siege_not_found" });
    const { siegeId } = seed(d);
    d.update(schema.sieges).set({ attemptTx: "stub:0.0.0@1.1" }).where(eq(schema.sieges.id, siegeId)).run();
    expect(await c.recordAttempt(siegeId)).toEqual({ ok: false, reason: "already_recorded" });
  });

  it("release refuses free sieges, non-broken sieges and bad signatures", async () => {
    const devSigner = privateKeyToAccount(DEV_VERIFIER_KEY);
    const free = seed(d, { status: "broken", free: true });
    expect(await c.release(free.siegeId, verdict(free.siegeId, "0x00"))).toEqual({ ok: false, reason: "free_siege" });
    const held = seed(d, { status: "held" });
    expect(await c.release(held.siegeId, verdict(held.siegeId, "0x00"))).toEqual({ ok: false, reason: "bad_status" });

    const broken = seed(d, { status: "broken" });
    expect(await c.release(broken.siegeId, verdict(broken.siegeId, `0x${"00".repeat(65)}`))).toEqual({ ok: false, reason: "bad_signature" });
    // signed by the right key but for another vault
    const wrong = await devSigner.signTypedData({
      domain: { name: "SiegeVault", version: "1", chainId: 296, verifyingContract: "0x5e1e6e0000000000000000000000000000000001" },
      types: { Release: [{ name: "vaultId", type: "uint256" }, { name: "raider", type: "address" }, { name: "transcriptHash", type: "bytes32" }, { name: "siegeId", type: "bytes32" }] },
      primaryType: "Release",
      message: { vaultId: B(999), raider: "0x0000000000000000000000000000000000000001", transcriptHash: HASH, siegeId: HASH },
    });
    expect(await c.release(broken.siegeId, verdict(broken.siegeId, wrong))).toEqual({ ok: false, reason: "bad_signature" });
    // a verdict that does not match
    expect(await c.release(broken.siegeId, { ...verdict(broken.siegeId, wrong), ok: false })).toEqual({ ok: false, reason: "not_verified" });
  });

  it("createVault increments from max(castles.vaultId)+1", async () => {
    seed(d, { vaultId: 41 });
    const a = await c.createVault({ castleId: "x", pot: "100", fee: "10", durationSec: 60, castellan: "0.0.1" });
    const b = await c.createVault({ castleId: "y", pot: "100", fee: "10", durationSec: 60, castellan: "0.0.1" });
    expect(a.ok && a.vaultId).toBe(42);
    expect(b.ok && b.vaultId).toBe(43);
    expect(await c.createVault({ castleId: "z", pot: "0", fee: "10", durationSec: 60, castellan: "0.0.1" })).toEqual({ ok: false, reason: "bad_args" });
  });

  it("audit writes compact rows with a per-topic sequence", async () => {
    const one = seed(d);
    const two = seed(d);
    const at = new Date().toISOString();
    const a1 = await c.audit({ siegeId: one.siegeId, castleId: one.castleId, type: "start", payload: { text: "hello guardian" }, at });
    const a2 = await c.audit({ siegeId: one.siegeId, type: "decision", turn: 2, payload: { requestId: "0g-1", reply: "no" }, at });
    const b1 = await c.audit({ siegeId: two.siegeId, castleId: two.castleId, type: "end", payload: { transcriptHash: HASH }, at });
    expect(a1).toEqual({ ok: true, topicId: `0.0.stub-${one.castleId}`, seq: 1 });
    expect(a2).toEqual({ ok: true, topicId: `0.0.stub-${one.castleId}`, seq: 2 });
    expect(b1).toEqual({ ok: true, topicId: `0.0.stub-${two.castleId}`, seq: 1 });
    const rows = d.select().from(schema.auditLog).all();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(Buffer.byteLength(r.message)).toBeLessThanOrEqual(1000);
      expect(r.message).not.toMatch(/hello|SECRET|"no"/);
      expect(JSON.parse(r.message).v).toBe(1);
    }
    expect(JSON.parse(rows[1].message)).toMatchObject({ type: "decision", turn: 2, requestId: "0g-1", castleId: one.castleId });
    expect(JSON.parse(rows[2].message)).toMatchObject({ hash: HASH });
    expect(await c.audit({ siegeId: "", type: "approval", payload: {}, at })).toEqual({ ok: false, reason: "no_castle" });
  });
});

describe("chain (env-selected, shared db)", () => {
  it("is in stub mode with stub chain info", () => {
    expect(chain.mode).toBe("stub");
    const info = chainInfo();
    expect(info).toMatchObject({ mode: "stub", network: "hedera:testnet", chainId: 296, explorer: "https://hashscan.io/testnet" });
    expect(info.vaultUrl).toBeUndefined();
  });

  it("prepareRelease -> sign with dev key -> release pays pot + fee", async () => {
    const d = db();
    const { siegeId } = seed(d, { status: "broken", fee: 50_000_000, pot: 500_000_000 });
    const prep = await prepareRelease(siegeId);
    if (!prep.ok) throw new Error(prep.reason);
    expect(prep.vaultId).toBeGreaterThan(0);
    const sig = await privateKeyToAccount(DEV_VERIFIER_KEY).signTypedData(prep.typedData);
    const r = await chain.release(siegeId, verdict(siegeId, sig));
    if (!r.ok) throw new Error(r.reason);
    expect(r.amount).toBe("550000000");
    expect(r.tx.stub).toBe(true);
    // transcript mismatch is refused before the signature check
    expect(await chain.release(siegeId, { ...verdict(siegeId, sig), transcriptHash: `0x${"00".repeat(32)}` })).toEqual({
      ok: false,
      reason: "transcript_mismatch",
    });
  });

  it("prepareRelease refuses free, non-broken and hashless sieges", async () => {
    const d = db();
    expect(await prepareRelease(seed(d, { status: "broken", free: true }).siegeId)).toEqual({ ok: false, reason: "free_siege" });
    expect(await prepareRelease(seed(d, { status: "held" }).siegeId)).toEqual({ ok: false, reason: "bad_status" });
    expect(await prepareRelease(seed(d, { status: "broken", transcriptHash: null }).siegeId)).toEqual({ ok: false, reason: "no_transcript" });
  });
});
