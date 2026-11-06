import { describe, expect, it } from "vitest";
import type { Castle } from "@/lib/types";
import { applyOrder, orderFrom, sortCastles } from "./sort";
import { reconTarget, isReconUsed } from "./recon-briefing";
import { seasonFromCastles } from "./season-strip";
import { untilText } from "./vault-card";
import { ApiError } from "@/lib/api/client";

const HBAR = { id: "0.0.0", decimals: 8, symbol: "HBAR" };
function castle(id: string, p: Partial<Castle>): Castle {
  return {
    id,
    name: id,
    guardianName: "g",
    title: "Recruit",
    personality: "stern",
    tier: "stone",
    pot: "0",
    fee: "100000000",
    asset: HBAR,
    streak: 0,
    siegeCount: 0,
    status: "open",
    owner: "0.0.1",
    vaultId: 1,
    topicId: null,
    protectedTool: "unlock_vault",
    vaultState: "guarding",
    transport: "hosted",
    deadline: 0,
    createdAt: "2026-11-01T00:00:00Z",
    ...p,
  };
}

const wooden = castle("wooden", { tier: "wooden", pot: "500000000", fee: "50000000", siegeCount: 8 });
const stoneBig = castle("stoneBig", { tier: "stone", pot: "2500000000", streak: 27, siegeCount: 30, createdAt: "2026-11-03T00:00:00Z" });
const stoneSmall = castle("stoneSmall", { tier: "stone", pot: "1500000000", streak: 12, siegeCount: 19 });
const iron = castle("iron", { tier: "iron", pot: "5000000000", fee: "200000000", streak: 212, siegeCount: 212 });
const sdk = castle("sdk", { tier: "stone", pot: "1000000000", transport: "sdk", vaultState: "created", siegeCount: 0 });
const broken = castle("broken", { tier: "wooden", status: "broken", vaultState: "broken", pot: "0" });
const all = [iron, stoneSmall, sdk, wooden, stoneBig];
const ids = (cs: Castle[]) => cs.map((c) => c.id);

describe("grid sort", () => {
  it("EASIEST is tier ascending (production counts as 3), then the biggest pot", () => {
    expect(ids(sortCastles(all, "easiest"))).toEqual(["wooden", "stoneBig", "stoneSmall", "iron", "sdk"]);
  });
  it("BIGGEST POT, LONGEST STREAK, CHEAPEST FEE, NEWEST", () => {
    expect(ids(sortCastles(all, "pot"))[0]).toBe("iron");
    expect(ids(sortCastles(all, "streak"))[0]).toBe("iron");
    expect(ids(sortCastles(all, "fee"))[0]).toBe("wooden");
    expect(ids(sortCastles(all, "recent"))[0]).toBe("stoneBig");
  });
  it("QUIET puts vaults with a live op last, then fewest ops", () => {
    expect(ids(sortCastles(all, "quiet", new Set(["sdk"])))).toEqual(["wooden", "stoneSmall", "stoneBig", "iron", "sdk"]);
  });
  it("does not mutate the input", () => {
    const copy = [...all];
    sortCastles(all, "easiest");
    expect(all).toEqual(copy);
  });
  it("maps orders onto the Arkiv sort and the order param, and back", () => {
    expect(applyOrder({ tier: "iron" }, "streak")).toEqual({ query: { tier: "iron", sort: "streak" }, orderParam: null });
    expect(applyOrder({ sort: "fee" }, "pot")).toEqual({ query: { sort: undefined }, orderParam: "pot" });
    expect(applyOrder({ sort: "fee" }, "easiest")).toEqual({ query: { sort: undefined }, orderParam: null });
    expect(orderFrom({ sort: "recent" }, new URLSearchParams("order=pot"))).toBe("recent");
    expect(orderFrom({}, new URLSearchParams("order=quiet"))).toBe("quiet");
    expect(orderFrom({}, new URLSearchParams("order=bogus"))).toBe("easiest");
  });
});

describe("recon briefing", () => {
  it("targets the lowest-tier guarding vault", () => {
    expect(reconTarget(all)?.id).toBe("wooden");
    expect(reconTarget([broken, iron, stoneSmall])?.id).toBe("stoneSmall");
    expect(reconTarget([broken, sdk])).toBeUndefined();
  });
  it("recognises a spent recon (429 / free_used)", () => {
    expect(isReconUsed(new ApiError(429, { error: "free_used" }))).toBe(true);
    expect(isReconUsed(new ApiError(400, { error: "free_used" }))).toBe(true);
    expect(isReconUsed(new ApiError(402, { error: "payment_failed" }))).toBe(false);
    expect(isReconUsed(new Error("x"))).toBe(false);
  });
});

describe("season fallback + expiry text", () => {
  it("counts guarding vaults, pots in guarding vaults, ops and breaches", () => {
    const s = seasonFromCastles([...all, broken]);
    expect(s).toMatchObject({ vaults: 6, guarding: 4, breaches: 1, ops: 8 + 30 + 19 + 212 });
    expect(s.inPots).toBe(String(500000000 + 2500000000 + 1500000000 + 5000000000));
  });
  it("untilText is coarse and never a seconds countdown", () => {
    const now = Date.parse("2026-11-06T00:00:00Z");
    expect(untilText(undefined, now)).toBe("");
    expect(untilText(now - 1, now)).toBe("expired");
    expect(untilText(now + 30_000, now)).toBe("soon");
    expect(untilText(now + 45 * 60_000, now)).toBe("in 45m");
    expect(untilText(now + (2 * 24 + 21) * 3600_000, now)).toBe("in 2d 21h");
  });
});
