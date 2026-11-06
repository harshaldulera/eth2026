import { beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { FIXTURE_CASTLES, loadOrders } from "@/lib/fixtures/castles";
import { arkiv } from "@/lib/arkiv";
import { siege } from "@/lib/siege";
import { WOODEN_BREAK } from "@/lib/fixtures/raids";
import { castleRow, getCastle, listCastles, titleFor } from "./castles";

describe("castles", () => {
  beforeEach(() => {
    freshFixtureDb();
  });

  it("never exposes orders; raw row has them", () => {
    for (const c of listCastles()) expect(JSON.stringify(c)).not.toMatch(/orders|open_vault/i);
    expect(castleRow("castle_iron_warden")!.orders).toBe(loadOrders("iron"));
    expect(loadOrders("wooden")).toMatch(/open_vault/);
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
    expect(await arkiv.profile("0.0.r")).toMatchObject({ kind: "raider", sieges: 1, breaks: 1 });
    expect(await arkiv.profile("0.0.nobody")).toBeNull();
    expect((await arkiv.listCastles({ tier: "iron" }))[0].id).toBe("castle_iron_warden");
  });
});
