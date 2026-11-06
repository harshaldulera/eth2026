import { describe, expect, it } from "vitest";
import { guardRank, guardRankLevel, operatorRank, rankedUp } from "./ranks";
import { titleFor } from "@/lib/castles";

describe("guardRank", () => {
  it("maps the server titles", () => {
    expect(guardRank("Recruit")).toBe("SENTRY");
    expect(guardRank("Warden")).toBe("GUARD");
    expect(guardRank("Iron Warden")).toBe("SENTINEL");
    expect(guardRank("Unbroken")).toBe("UNBREACHED");
    expect(guardRank(" iron warden ")).toBe("SENTINEL");
  });

  it("maps streaks at the documented floors", () => {
    expect(guardRank(0)).toBe("SENTRY");
    expect(guardRank(9)).toBe("SENTRY");
    expect(guardRank(10)).toBe("GUARD");
    expect(guardRank(49)).toBe("GUARD");
    expect(guardRank(50)).toBe("SENTINEL");
    expect(guardRank(199)).toBe("SENTINEL");
    expect(guardRank(200)).toBe("UNBREACHED");
    expect(guardRank(212)).toBe("UNBREACHED");
  });

  it("agrees with the server's title for every streak", () => {
    for (const s of [0, 1, 9, 10, 11, 49, 50, 51, 199, 200, 1000]) {
      expect(guardRank(titleFor(s))).toBe(guardRank(s));
    }
  });

  it("falls back to SENTRY for junk", () => {
    expect(guardRank(undefined)).toBe("SENTRY");
    expect(guardRank("Lord")).toBe("SENTRY");
    expect(guardRank(Number.NaN)).toBe("SENTRY");
    expect(guardRank(-5)).toBe("SENTRY");
  });

  it("has chevron levels 0..3", () => {
    expect([guardRankLevel("SENTRY"), guardRankLevel("GUARD"), guardRankLevel("SENTINEL"), guardRankLevel("UNBREACHED")]).toEqual([0, 1, 2, 3]);
  });
});

describe("operatorRank", () => {
  it("starts as a script kiddie", () => {
    expect(operatorRank()).toBe("SCRIPT KIDDIE");
    expect(operatorRank({ ops: 2, flagsSurvived: 1 })).toBe("SCRIPT KIDDIE");
  });
  it("becomes an operator with ops or survived flags", () => {
    expect(operatorRank({ ops: 3 })).toBe("OPERATOR");
    expect(operatorRank({ ops: 1, flagsSurvived: 2 })).toBe("OPERATOR");
  });
  it("a first breach makes a red teamer, three a legend", () => {
    expect(operatorRank({ ops: 1, breaches: 1 })).toBe("RED TEAMER");
    expect(operatorRank({ ops: 9, breaches: 2 })).toBe("RED TEAMER");
    expect(operatorRank({ breaches: 3 })).toBe("LEGEND");
  });
  it("ignores negative and NaN counts", () => {
    expect(operatorRank({ ops: -10, breaches: Number.NaN })).toBe("SCRIPT KIDDIE");
  });
  it("detects a rank up", () => {
    expect(rankedUp("OPERATOR", "RED TEAMER")).toBe(true);
    expect(rankedUp("LEGEND", "RED TEAMER")).toBe(false);
    expect(rankedUp("OPERATOR", "OPERATOR")).toBe(false);
  });
});
