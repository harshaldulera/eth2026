import { describe, expect, it } from "vitest";
import { formatAmount } from "./format";

describe("formatAmount", () => {
  it("trims trailing zeros by default", () => {
    expect(formatAmount("2500000000")).toBe("25 ℏ");
    expect(formatAmount("5030000000", undefined, { maxDecimals: 2 })).toBe("50.3 ℏ");
  });

  it("minDecimals keeps a fixed fraction (arcade digits line up)", () => {
    const two = { symbol: false, minDecimals: 2, maxDecimals: 2 } as const;
    expect(formatAmount("2500000000", undefined, two)).toBe("25.00");
    expect(formatAmount("5030000000", undefined, two)).toBe("50.30");
    expect(formatAmount("2015000000", undefined, two)).toBe("20.15");
    expect(formatAmount("550000000", undefined, two)).toBe("5.50");
    expect(formatAmount("0", undefined, two)).toBe("0.00");
    // rounds half-up at the max
    expect(formatAmount("123456789", undefined, two)).toBe("1.23");
  });
});
