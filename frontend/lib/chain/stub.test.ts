import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { privateKeyToAccount } from "viem/accounts";
import { db, openTestDb, schema, type DB } from "@/lib/db";
import type { Verification } from "@/lib/types";
import { chain, chainInfo, prepareRelease } from "./index";
import { DEV_VERIFIER_KEY } from "./releaseSig";
import { createStubChain, stubVaultTool } from "./stub";

const B = (n: number | string) => BigInt(n);
const HASH = `0x${"cd".repeat(32)}` as `0x${string}`;
const FUTURE = Date.now() + 7 * 86_400_000;

let n = 0;
function seed(
  d: DB,
  o: {
    fee?: number;
    pot?: number;
    status?: "created" | "in_progress" | "held" | "broken" | "banished";
    free?: boolean;
    deadline?: number;
    transcriptHash?: string | null;
    vaultId?: number | null;
    vaultState?: "created" | "funded" | "guarding" | "dormant" | "broken" | "closed";
  } = {},
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
      vaultAddress: "stub",
      vaultState: o.vaultState ?? "guarding",
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

  it("createVault increments from max(castles.vaultId)+1 and records the protected tool", async () => {
    seed(d, { vaultId: 10_000 });
    const v = { pot: "100", fee: "10", durationSec: 60, castellan: "0.0.1", protectedTool: "unlock_vault" };
    const a = await c.createVault({ castleId: "x", ...v });
    const b = await c.createVault({ castleId: "y", ...v, protectedTool: "issue_refund" });
    if (!a.ok || !b.ok) throw new Error("createVault failed");
    expect(a.vaultId).toBeGreaterThanOrEqual(10_001);
    expect(b.vaultId).toBe(a.vaultId + 1);
    expect(stubVaultTool(a.vaultId)).toBe("unlock_vault");
    expect(stubVaultTool(b.vaultId)).toBe("issue_refund");
    expect(await c.createVault({ castleId: "z", ...v, pot: "0" })).toEqual({ ok: false, reason: "bad_args" });
    // Same bounds as the contract: 1..64 bytes.
    expect(await c.createVault({ castleId: "z", ...v, protectedTool: "" })).toEqual({ ok: false, reason: "bad_args" });
    expect(await c.createVault({ castleId: "z", ...v, protectedTool: "t".repeat(65) })).toEqual({ ok: false, reason: "bad_args" });
    expect((await c.createVault({ castleId: "z", ...v, protectedTool: "t".repeat(64) })).ok).toBe(true);
  });

  describe("closeVault", () => {
    /** A castle with one settled held siege, one in-flight paid siege, one in-flight free siege, one ended-unsettled paid siege. */
    function castleWithSieges(o: Parameters<typeof seed>[1] = {}) {
      const base = seed(d, { status: "held", ...o });
      d.update(schema.sieges).set({ settledAt: new Date().toISOString(), attemptTx: "stub:0.0.0@1.1" }).where(eq(schema.sieges.id, base.siegeId)).run();
      const add = (id: string, status: "in_progress" | "held", free: boolean) => {
        const receiptId = free ? null : `rcpt_${id}`;
        if (receiptId)
          d.insert(schema.paymentReceipts)
            .values({ id: receiptId, siegeId: id, payer: "0.0.2002", amountTinybar: 100_000_000, asset: "0.0.0", free: false, stub: true, createdAt: new Date().toISOString() })
            .run();
        d.insert(schema.sieges).values({ id, castleId: base.castleId, raider: "0.0.2002", free, status, receiptId, createdAt: new Date().toISOString() }).run();
      };
      add(`${base.siegeId}_live`, "in_progress", false);
      add(`${base.siegeId}_free`, "in_progress", true);
      add(`${base.siegeId}_ended`, "held", false);
      const vaultId = d.select().from(schema.castles).where(eq(schema.castles.id, base.castleId)).get()!.vaultId!;
      return { ...base, vaultId };
    }
    const receipt = (id: string) => d.select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.siegeId, id)).get();
    const siege = (id: string) => d.select().from(schema.sieges).where(eq(schema.sieges.id, id)).get()!;

    it("orders_changed: returns the pot and voids every unsettled paid siege for refund", async () => {
      const x = castleWithSieges({ pot: 700_000_000 });
      const r = await c.closeVault(x.vaultId, "orders_changed");
      if (!r.ok) throw new Error(r.reason);
      expect(r.refunded).toBe("700000000");
      expect(r.tx.stub).toBe(true);
      expect(r.inFlightRefunds).toBe(2); // the live paid siege and the ended-unsettled one; free has nothing to refund
      expect(receipt(`${x.siegeId}_live`)?.state).toBe("refund_due");
      expect(receipt(`${x.siegeId}_ended`)?.state).toBe("refund_due");
      expect(siege(`${x.siegeId}_live`).voidReason).toBe("castle_closed_orders_changed");
      expect(siege(`${x.siegeId}_free`).voidReason).toBe("castle_closed_orders_changed");
      expect(receipt(x.siegeId)?.state).toBe("settled"); // the settled siege is untouched
      // It does not touch the castle (the caller transitions the vault state), but a second close is refused.
      expect(d.select().from(schema.castles).where(eq(schema.castles.id, x.castleId)).get()).toMatchObject({ status: "open", vaultState: "guarding" });
      expect(await c.closeVault(x.vaultId, "owner_closed")).toEqual({ ok: false, reason: "vault_not_open" });
    });

    it("expired needs the deadline; owner_closed does not", async () => {
      const early = castleWithSieges();
      expect(await c.closeVault(early.vaultId, "expired")).toEqual({ ok: false, reason: "not_expired" });
      expect(receipt(`${early.siegeId}_live`)?.state).toBe("settled"); // nothing voided on a refusal
      expect((await c.closeVault(early.vaultId, "owner_closed")).ok).toBe(true);
      const late = castleWithSieges({ deadline: Date.now() - 1000 });
      expect((await c.closeVault(late.vaultId, "expired")).ok).toBe(true);
    });

    it("refuses vaults that are not open: unknown, broken, closed, never funded", async () => {
      expect(await c.closeVault(999_999, "owner_closed")).toEqual({ ok: false, reason: "vault_not_open" });
      for (const vaultState of ["broken", "closed", "created"] as const) {
        const x = seed(d, { vaultState });
        const vaultId = d.select().from(schema.castles).where(eq(schema.castles.id, x.castleId)).get()!.vaultId!;
        expect(await c.closeVault(vaultId, "owner_closed")).toEqual({ ok: false, reason: "vault_not_open" });
      }
      // dormant: still funded on chain, so it can close
      const dormant = seed(d, { vaultState: "dormant" });
      const vid = d.select().from(schema.castles).where(eq(schema.castles.id, dormant.castleId)).get()!.vaultId!;
      expect((await c.closeVault(vid, "orders_changed")).ok).toBe(true);
    });
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
    expect(rows.map((r) => r.type)).toEqual(["siege.start", "siege.decision", "siege.end"]);
    expect(JSON.parse(rows[1].message)).toMatchObject({ type: "siege.decision", turn: 2, requestId: "0g-1", castleId: one.castleId });
    expect(JSON.parse(rows[2].message)).toMatchObject({ type: "siege.end", hash: HASH });
    expect(await c.audit({ siegeId: "", type: "approval", payload: {}, at })).toEqual({ ok: false, reason: "no_castle" });
  });

  it("audit: vault_state becomes HCS \"vault.state\" {from,to,reason}; siege messages carry transport + request id", async () => {
    const x = seed(d);
    const at = new Date().toISOString();
    const v = await c.audit({ siegeId: "", castleId: x.castleId, type: "vault_state", payload: { castleId: x.castleId, from: "guarding", to: "dormant", reason: "three missed heartbeats", at }, at });
    expect(v.ok).toBe(true);
    await c.audit({ siegeId: x.siegeId, castleId: x.castleId, type: "message", turn: 1, transport: "sdk", requestId: "proxy-req-1", payload: { hash: HASH }, at });
    const [vs, msg] = d.select().from(schema.auditLog).where(eq(schema.auditLog.castleId, x.castleId)).all();
    expect(vs.type).toBe("vault.state");
    expect(JSON.parse(vs.message)).toEqual({ v: 1, type: "vault.state", castleId: x.castleId, from: "guarding", to: "dormant", reason: "three missed heartbeats", at });
    expect(msg.type).toBe("siege.message");
    expect(JSON.parse(msg.message)).toMatchObject({ type: "siege.message", turn: 1, transport: "sdk", requestId: "proxy-req-1", hash: HASH });
    // a huge multi-byte reason still fits in one HCS message
    await c.audit({ siegeId: "", castleId: x.castleId, type: "vault_state", payload: { from: "guarding", to: "closed", reason: "🏰".repeat(5000) }, at });
    const big = d.select().from(schema.auditLog).where(eq(schema.auditLog.castleId, x.castleId)).all().at(-1)!;
    expect(Buffer.byteLength(big.message)).toBeLessThanOrEqual(1000);
    expect(JSON.parse(big.message).to).toBe("closed");
  });

  it("audit: plan A4 type strings; siege.end carries the result; attempt/release carry the transport", async () => {
    const x = seed(d);
    const at = new Date().toISOString();
    const ev = (type: "start" | "end" | "attempt" | "release", payload: Record<string, unknown>) =>
      c.audit({ siegeId: x.siegeId, castleId: x.castleId, type, transport: "hosted", payload, at });
    await ev("start", { txId: "0.0.1@1.2" });
    await ev("end", { result: "broken", transcriptHash: HASH, requestId: "proxy-req-9" });
    await ev("attempt", { txId: "0xatt" });
    await ev("release", { txId: "0xrel", transcriptHash: HASH });
    const rows = d.select().from(schema.auditLog).where(eq(schema.auditLog.castleId, x.castleId)).all();
    expect(rows.map((r) => r.type)).toEqual(["siege.start", "siege.end", "siege.attempt", "vault.release"]);
    const msgs = rows.map((r) => JSON.parse(r.message));
    expect(msgs.map((m) => m.type)).toEqual(["siege.start", "siege.end", "siege.attempt", "vault.release"]);
    expect(msgs[1]).toMatchObject({ result: "broken", hash: HASH, requestId: "proxy-req-9", transport: "hosted" });
    expect(msgs[3]).toMatchObject({ txId: "0xrel", transport: "hosted" });
    expect(msgs[0].result).toBeUndefined();
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
    // write-ahead like testnet: the siege carries the "landed" tx until the worker applies it, so a vault
    // close racing the worker cannot void it, and a retry returns the same landed write
    expect(d.select().from(schema.sieges).where(eq(schema.sieges.id, siegeId)).get()!.pendingTx).toBe(r.tx.txId);
    expect(await chain.release(siegeId, verdict(siegeId, sig))).toMatchObject({ ok: true, tx: { txId: r.tx.txId } });
    // transcript mismatch is refused before the signature check
    const other = seed(d, { status: "broken", fee: 50_000_000, pot: 500_000_000 });
    const prep2 = await prepareRelease(other.siegeId);
    if (!prep2.ok) throw new Error(prep2.reason);
    const sig2 = await privateKeyToAccount(DEV_VERIFIER_KEY).signTypedData(prep2.typedData);
    expect(await chain.release(other.siegeId, { ...verdict(other.siegeId, sig2), transcriptHash: `0x${"00".repeat(32)}` })).toEqual({
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
