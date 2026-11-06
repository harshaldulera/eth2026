/**
 * lib/vault: the legal-transition table, castles.status sync, the vault_state event + HCS "vault.state"
 * audit + Arkiv write on every transition, dormant/close refunds through the normal refund loop, and
 * funding / closing / expiring vaults through the stub chain.
 */
import { beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { eq } from "drizzle-orm";
import { resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { fixtureCastleRow, FIXTURE_CASTLES } from "@/lib/fixtures/castles";
import { arkivStubWrites } from "@/lib/arkiv";
import { reconcileReceipts } from "@/lib/pay/refunds";
import { stubVaultTool } from "@/lib/chain/stub";
import type { TransportKind, VaultState } from "@/lib/types";
import {
  closeCastle,
  closeExpiredVaults,
  fundVault,
  isGuarding,
  isLegalTransition,
  siegeBlockedReason,
  transitionVault,
  vaultState,
  VAULT_STATES,
} from "./index";

const C = schema.castles;
const WOOD = "castle_splinter_gate";
const SDK = "castle_sdk_test";

function addSdkCastle(state: VaultState = "created", o: { vaultId?: number | null; deadline?: number } = {}) {
  const f = { ...FIXTURE_CASTLES[1], id: SDK, name: "SDK Test Desk", transport: "sdk" as const, protectedTool: "issue_refund" };
  db()
    .insert(C)
    .values({ ...fixtureCastleRow(f, { vaultState: state, vaultId: o.vaultId ?? null, deadline: o.deadline }), vaultAddress: o.vaultId != null ? "stub" : null })
    .run();
}

const castle = (id: string) => db().select().from(C).where(eq(C.id, id)).get()!;
const vaultEvents = (id: string) => db().select().from(schema.events).where(eq(schema.events.castleId, id)).all().filter((e) => e.type === "vault_state");
const vaultAudits = (id: string) =>
  db().select().from(schema.auditLog).where(eq(schema.auditLog.castleId, id)).all().filter((a) => a.type === "vault.state");

let n = 0;
/** A siege on a castle; paid ones get a settled stub receipt. */
function addSiege(castleId: string, o: { free?: boolean; status?: "in_progress" | "held"; settled?: boolean } = {}) {
  n++;
  const id = `siege_vt${n}`;
  const receiptId = o.free ? null : `rcpt_vt${n}`;
  if (receiptId)
    db()
      .insert(schema.paymentReceipts)
      .values({ id: receiptId, siegeId: id, payer: "0.0.stub-raider", amountTinybar: 100_000_000, asset: "0.0.0", free: false, stub: true, createdAt: new Date().toISOString() })
      .run();
  db()
    .insert(schema.sieges)
    .values({
      id,
      castleId,
      raider: "0.0.stub-raider",
      free: o.free ?? false,
      status: o.status ?? "in_progress",
      receiptId,
      createdAt: new Date().toISOString(),
      settledAt: o.settled ? new Date().toISOString() : null,
      attemptTx: o.settled ? "stub:0.0.0@1.1" : null,
    })
    .run();
  return id;
}
const receiptState = (siegeId: string) => db().select().from(schema.paymentReceipts).where(eq(schema.paymentReceipts.siegeId, siegeId)).get()?.state;
const siegeRow = (id: string) => db().select().from(schema.sieges).where(eq(schema.sieges.id, id)).get()!;

beforeEach(() => {
  process.env.CHAIN_MODE = "stub";
  freshFixtureDb();
  resetEnv();
});

describe("legal transitions", () => {
  const legal: [VaultState, VaultState, TransportKind][] = [
    ["created", "verified", "hosted"],
    ["created", "connected", "sdk"],
    ["connected", "verified", "sdk"],
    ["verified", "funded", "hosted"],
    ["verified", "funded", "sdk"],
    ["funded", "guarding", "hosted"],
    ["guarding", "dormant", "sdk"],
    ["dormant", "guarding", "sdk"],
    ["guarding", "broken", "hosted"],
    ["dormant", "broken", "sdk"],
  ];
  const illegal: [VaultState, VaultState, TransportKind][] = [
    ["created", "guarding", "hosted"],
    ["created", "funded", "hosted"],
    ["created", "connected", "hosted"], // only an SDK harness connects
    ["created", "verified", "sdk"], // an SDK vault must connect first
    ["guarding", "dormant", "hosted"], // hosted guardians have no heartbeat
    ["funded", "verified", "hosted"],
    ["guarding", "funded", "hosted"],
    ["guarding", "guarding", "hosted"],
    ["funded", "broken", "hosted"], // only a guarding vault takes sieges
    ["broken", "guarding", "hosted"],
    ["closed", "guarding", "sdk"],
    ["broken", "closed", "hosted"],
  ];
  it.each(legal)("%s -> %s (%s) is legal", (from, to, t) => expect(isLegalTransition(from, to, t)).toBe(true));
  it.each(illegal)("%s -> %s (%s) is illegal", (from, to, t) => expect(isLegalTransition(from, to, t)).toBe(false));
  it("every non-terminal state may close; nothing leaves broken or closed", () => {
    for (const from of VAULT_STATES) {
      for (const t of ["hosted", "sdk"] as const) {
        if (t === "hosted" && (from === "connected" || from === "dormant")) continue; // a hosted vault is never in these
        const terminal = from === "broken" || from === "closed";
        expect(isLegalTransition(from, "closed", t)).toBe(!terminal);
        if (terminal) for (const to of VAULT_STATES) expect(isLegalTransition(from, to, t)).toBe(false);
      }
    }
  });
});

describe("vaultState.transition", () => {
  it("walks an SDK castle to guarding: DB + status sync + event + HCS vault.state + Arkiv, every step", async () => {
    addSdkCastle("created");
    expect(await vaultState.get(SDK)).toBe("created");
    expect(isGuarding(SDK)).toBe(false);
    expect(siegeBlockedReason(SDK)).toBe("not_guarding");
    const steps: [VaultState, string][] = [
      ["connected", "handshake"],
      ["verified", "smoke siege passed"],
      ["funded", "vault #7 funded"],
      ["guarding", "open for sieges"],
    ];
    for (const [to, reason] of steps) {
      const r = await transitionVault(SDK, to, reason, { awaitSideEffects: true });
      expect(r).toMatchObject({ ok: true, change: { castleId: SDK, to, reason } });
      expect(castle(SDK)).toMatchObject({ vaultState: to, vaultStateReason: reason, status: "open" });
    }
    expect(isGuarding(SDK)).toBe(true);
    expect(siegeBlockedReason(SDK)).toBeNull();
    const evs = vaultEvents(SDK);
    expect(evs.map((e) => JSON.parse(e.payload).to)).toEqual(["connected", "verified", "funded", "guarding"]);
    expect(evs.every((e) => e.siegeId === "")).toBe(true);
    expect(JSON.parse(evs[0].payload)).toMatchObject({ castleId: SDK, from: "created", to: "connected", reason: "handshake" });
    const audits = vaultAudits(SDK).map((a) => JSON.parse(a.message));
    expect(audits.map((a) => [a.from, a.to])).toEqual([
      ["created", "connected"],
      ["connected", "verified"],
      ["verified", "funded"],
      ["funded", "guarding"],
    ]);
    expect(audits[3]).toMatchObject({ v: 1, type: "vault.state", castleId: SDK, reason: "open for sieges" });
    const entity = arkivStubWrites().get(`arkiv-stub:castle:${SDK}`) as { annotations?: { vaultState?: string }; vaultState?: string };
    expect(entity?.annotations?.vaultState ?? entity?.vaultState).toBe("guarding");
  });

  it("illegal transitions and unknown castles change nothing", async () => {
    addSdkCastle("created");
    expect(await vaultState.transition(SDK, "guarding", "skip")).toEqual({ ok: false, reason: "illegal_transition" });
    expect(await vaultState.transition(SDK, "verified", "skip connected")).toEqual({ ok: false, reason: "illegal_transition" });
    expect(await vaultState.transition("castle_nope", "closed", "x")).toEqual({ ok: false, reason: "not_found" });
    expect(await vaultState.transition(SDK, "bogus" as VaultState, "x")).toEqual({ ok: false, reason: "illegal_transition" });
    expect(castle(SDK).vaultState).toBe("created");
    expect(vaultEvents(SDK)).toHaveLength(0);
    expect(await vaultState.get("castle_nope")).toBeNull();
  });

  it("status sync: broken -> broken, closed -> closed", async () => {
    // broken is the worker's (verified release); the port refuses it
    expect(await vaultState.transition(WOOD, "broken", "paid out to 0.0.1")).toEqual({ ok: false, reason: "illegal_transition" });
    expect((await transitionVault(WOOD, "broken", "paid out to 0.0.1")).ok).toBe(true);
    expect(castle(WOOD)).toMatchObject({ vaultState: "broken", status: "broken" });
    expect(await transitionVault(WOOD, "closed", "x")).toEqual({ ok: false, reason: "illegal_transition" });
    expect(await vaultState.transition(WOOD, "closed", "owner_closed")).toEqual({ ok: false, reason: "illegal_transition" });
    expect((await vaultState.transition("castle_granite_hold", "closed", "owner_closed")).ok).toBe(true);
    expect(castle("castle_granite_hold")).toMatchObject({ vaultState: "closed", status: "closed" });
    expect(siegeBlockedReason("castle_granite_hold")).toBe("closed");
  });

  it("dormant: in-flight sieges are voided, paid fees refunded by the normal refund loop; the vault stays funded", async () => {
    addSdkCastle("guarding", { vaultId: 4242 });
    const live = addSiege(SDK);
    const free = addSiege(SDK, { free: true });
    const done = addSiege(SDK, { status: "held", settled: true });
    const ended = addSiege(SDK, { status: "held" }); // ended, not settled yet: the vault is still funded, it can settle
    expect((await transitionVault(SDK, "dormant", "three missed heartbeats")).ok).toBe(true);
    expect(castle(SDK)).toMatchObject({ vaultState: "dormant", status: "open", vaultId: 4242 });
    expect(siegeRow(live).voidReason).toBe("guardian_dormant");
    expect(siegeRow(free).voidReason).toBe("guardian_dormant");
    expect(receiptState(live)).toBe("refund_due");
    expect(receiptState(done)).toBe("settled");
    expect(siegeRow(ended).voidReason).toBeNull();
    expect(receiptState(ended)).toBe("settled");
    const rep = await reconcileReceipts();
    expect(rep.refunded.map((r) => r.id)).toEqual([`rcpt_${live.replace("siege_", "")}`]);
    expect(receiptState(live)).toBe("refunded");
    expect(siegeBlockedReason(SDK)).toBe("not_guarding");
    // reconnect
    expect((await transitionVault(SDK, "guarding", "reconnected")).ok).toBe(true);
    expect(isGuarding(SDK)).toBe(true);
  });
});

describe("fund / close / expire", () => {
  it("fundVault: verified -> funded via createVault with the castle's protected tool", async () => {
    addSdkCastle("connected");
    expect(await fundVault(SDK)).toEqual({ ok: false, reason: "illegal_transition" });
    await transitionVault(SDK, "verified", "smoke ok");
    const r = await fundVault(SDK, { awaitSideEffects: true });
    if (!r.ok) throw new Error(r.reason);
    expect(stubVaultTool(r.vaultId)).toBe("issue_refund");
    expect(r.reason).toMatch(/^vault #\d+ funded with 20 ℏ$/);
    expect(castle(SDK)).toMatchObject({ vaultState: "funded", vaultId: r.vaultId, vaultAddress: "stub", createVaultTx: r.tx.txId });
    expect(JSON.parse(vaultAudits(SDK).at(-1)!.message)).toMatchObject({ from: "verified", to: "funded", reason: r.reason });
  });

  it("closeCastle: on-chain close, pot 0, in-flight paid sieges refunded, vault closed with the reason", async () => {
    addSdkCastle("guarding", { vaultId: 5151 });
    const live = addSiege(SDK);
    const pot = castle(SDK).potTinybar;
    const r = await closeCastle(SDK, "orders_changed");
    if (!r.ok) throw new Error(r.reason);
    expect(r.refunded).toBe(String(pot));
    expect(r.inFlightRefunds).toBe(1);
    expect(r.tx?.stub).toBe(true);
    expect(castle(SDK)).toMatchObject({ vaultState: "closed", vaultStateReason: "orders_changed", status: "closed", potTinybar: 0 });
    expect(receiptState(live)).toBe("refund_due");
    expect(siegeRow(live).voidReason).toBe("castle_closed_orders_changed");
    expect(await closeCastle(SDK, "owner_closed")).toMatchObject({ ok: false, reason: "illegal_transition", status: 409 });
  });

  it("closeCastle: an unfunded castle just closes; expired needs the deadline", async () => {
    addSdkCastle("created");
    expect(await closeCastle(SDK, "expired")).toMatchObject({ ok: false, reason: "not_expired" });
    const r = await closeCastle(SDK, "owner_closed");
    expect(r).toEqual({ ok: true, tx: null, refunded: "0", inFlightRefunds: 0 });
    expect(castle(SDK).vaultState).toBe("closed");
  });

  it("closeExpiredVaults closes castles past their deadline (on chain when funded)", async () => {
    addSdkCastle("guarding", { vaultId: 6161, deadline: Date.now() - 1000 });
    const r = await closeExpiredVaults();
    expect(r.closed.map((c) => c.castleId)).toEqual([SDK]);
    expect(r.closed[0].tx?.stub).toBe(true);
    expect(castle(SDK)).toMatchObject({ vaultState: "closed", vaultStateReason: "expired", potTinybar: 0 });
    expect((await closeExpiredVaults()).closed).toHaveLength(0);
    expect(castle(WOOD).vaultState).toBe("guarding");
  });
});
