import { beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { FIXTURE_CASTLES, SDK_FIXTURE_CASTLE, loadOrders, sdkFixtureCastleRow } from "@/lib/fixtures/castles";
import { arkiv, arkivStubWrites, type CastleEntity } from "@/lib/arkiv";
import { siege } from "@/lib/siege";
import { WOODEN_BREAK } from "@/lib/fixtures/raids";
import { castleClosedReason, castleRow, getCastle, listCastles, titleFor } from "./castles";

describe("castles", () => {
  beforeEach(() => {
    freshFixtureDb();
  });

  it("never exposes orders; raw row has them", () => {
    for (const c of listCastles()) {
      expect(JSON.stringify(c)).not.toMatch(/orders/i);
      expect(JSON.stringify(c)).not.toContain(loadOrders(c.tier).slice(0, 60));
    }
    expect(castleRow("castle_iron_warden")!.orders).toBe(loadOrders("iron"));
    for (const t of ["wooden", "stone", "iron"] as const) {
      expect(loadOrders(t)).toMatch(/unlock_vault/);
      expect(loadOrders(t)).not.toMatch(/open_vault/);
    }
  });

  it("maps fixture values, titles and asset", () => {
    const iron = getCastle("castle_iron_warden")!;
    expect(iron).toMatchObject({ fee: "200000000", pot: "5000000000", streak: 212, title: "Unbroken", tier: "iron" });
    expect(iron.asset).toEqual({ id: "0.0.0", decimals: 8, symbol: "HBAR" });
    expect(getCastle("castle_splinter_gate")!.fee).toBe("50000000");
    expect([titleFor(0), titleFor(10), titleFor(50), titleFor(200)]).toEqual(["Recruit", "Warden", "Iron Warden", "Unbroken"]);
    expect(iron.deadline).toBeGreaterThan(Date.now() + 2.9 * 24 * 3600 * 1000);
  });

  it("filters and sorts", () => {
    expect(listCastles()).toHaveLength(FIXTURE_CASTLES.length);
    expect(listCastles({ tier: "stone" }).map((c) => c.id).sort()).toEqual(["castle_granite_hold", "castle_grey_bastion", "castle_saltmarsh_keep"]);
    expect(listCastles({ minPot: "2000000000" }).map((c) => c.id)).toEqual(["castle_iron_warden", "castle_grey_bastion", "castle_granite_hold"]);
    expect(listCastles({ sort: "streak" })[0].id).toBe("castle_iron_warden");
    expect(listCastles({ sort: "fee" })[0].id).toBe("castle_splinter_gate");
    expect(listCastles({ status: "broken" })).toEqual([]);
  });

  it("arkiv stub: live sieges and raider profile", async () => {
    const s = await siege.start({ castleId: "castle_splinter_gate", raider: "0.0.r", receipt: { free: true, payer: "0.0.r" } });
    expect((await arkiv.liveSieges()).map((x) => x.id)).toEqual([s.id]);
    for (const t of WOODEN_BREAK) await siege.message(s.id, t);
    expect(await arkiv.liveSieges()).toEqual([]);
    // Free recon ops never count toward a profile (they are unlimited, so they could farm the
    // leaderboards); only paid, non-voided ops do.
    expect(await arkiv.profile("0.0.r")).toBeNull();
    expect(await arkiv.profile("0.0.nobody")).toBeNull();
    expect((await arkiv.listCastles({ tier: "iron" }))[0].id).toBe("castle_iron_warden");
  });

  it("maps vault state, transport and protected tool", () => {
    db().insert(schema.castles).values(sdkFixtureCastleRow()).run();
    const wood = getCastle("castle_splinter_gate")!;
    expect(wood).toMatchObject({ protectedTool: "unlock_vault", vaultState: "guarding", transport: "hosted" });
    expect(wood).not.toHaveProperty("vaultStateReason");
    expect(wood).not.toHaveProperty("lastSeenAt");
    db()
      .update(schema.castles)
      .set({ vaultState: "dormant", vaultStateReason: "three missed heartbeats", lastSeenAt: "2026-11-07T01:00:00.000Z" })
      .where(eq(schema.castles.id, SDK_FIXTURE_CASTLE.id))
      .run();
    expect(getCastle(SDK_FIXTURE_CASTLE.id)).toMatchObject({
      protectedTool: "issue_refund",
      transport: "sdk",
      vaultState: "dormant",
      vaultStateReason: "three missed heartbeats",
      lastSeenAt: "2026-11-07T01:00:00.000Z",
    });
    expect(listCastles({ transport: "sdk" }).map((c) => c.id)).toEqual([SDK_FIXTURE_CASTLE.id]);
    expect(listCastles({ vaultState: "dormant" }).map((c) => c.id)).toEqual([SDK_FIXTURE_CASTLE.id]);
    expect(listCastles({ vaultState: "guarding" })).toHaveLength(FIXTURE_CASTLES.length);
    expect(listCastles({ transport: "hosted", tier: "iron" }).map((c) => c.id)).toEqual(["castle_iron_warden"]);
  });

  it("castleClosedReason ignores the vault lifecycle (lib/vault/guards adds not_guarding)", () => {
    db().update(schema.castles).set({ vaultState: "dormant" }).where(eq(schema.castles.id, "castle_granite_hold")).run();
    expect(castleClosedReason("castle_granite_hold")).toBeNull();
    db().update(schema.castles).set({ status: "closed", vaultState: "closed" }).where(eq(schema.castles.id, "castle_granite_hold")).run();
    expect(castleClosedReason("castle_granite_hold")).toBe("closed");
  });

  it("arkiv stub: the board lists guarding castles only unless a vaultState is asked for; castle entities carry the vault fields", async () => {
    db().insert(schema.castles).values(sdkFixtureCastleRow({ vaultState: "dormant" })).run();
    const board = await arkiv.listCastles();
    expect(board.map((c) => c.id)).not.toContain(SDK_FIXTURE_CASTLE.id);
    expect(board.every((c) => c.vaultState === "guarding")).toBe(true);
    expect((await arkiv.listCastles({ vaultState: "dormant" })).map((c) => c.id)).toEqual([SDK_FIXTURE_CASTLE.id]);

    const { key } = await arkiv.writeCastle(getCastle(SDK_FIXTURE_CASTLE.id)!);
    const e = arkivStubWrites().get(key) as CastleEntity;
    expect(e.annotations).toMatchObject({ vaultState: "dormant", transport: "sdk", protectedTool: "issue_refund", tier: "stone" });
    expect(e.payload.id).toBe(SDK_FIXTURE_CASTLE.id);
    expect(JSON.stringify(e)).not.toContain("orders live");
  });
});
