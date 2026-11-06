import { describe, expect, it } from "vitest";
import { formatHbar, hbarToTinybar, tinybarToWei, weiToTinybar, TINYBAR_PER_HBAR, WEI_PER_TINYBAR } from "./units";
import { accountUrl, contractUrl, isStubRef, normalizeTxId, topicUrl, txUrl } from "./hashscan";

const B = (n: number | string) => BigInt(n);

describe("units", () => {
  it("tinybar <-> wei round trips", () => {
    expect(tinybarToWei(B(1))).toBe(B(10) ** B(10));
    expect(WEI_PER_TINYBAR).toBe(B("10000000000"));
    for (const t of [B(0), B(1), B(50_000_000), B("123456789012345")]) expect(weiToTinybar(tinybarToWei(t))).toBe(t);
  });

  it("weiToTinybar throws on sub-tinybar precision", () => {
    expect(() => weiToTinybar(B(1))).toThrow();
    expect(() => weiToTinybar(tinybarToWei(B(5)) + B(1))).toThrow();
  });

  it("hbarToTinybar parses decimals", () => {
    expect(hbarToTinybar("1")).toBe(B(100_000_000));
    expect(hbarToTinybar("1")).toBe(TINYBAR_PER_HBAR);
    expect(hbarToTinybar("0.5")).toBe(B(50_000_000));
    expect(hbarToTinybar(".25")).toBe(B(25_000_000));
    expect(hbarToTinybar("0.00000001")).toBe(B(1));
    expect(hbarToTinybar("-2.25")).toBe(B(-225_000_000));
    expect(hbarToTinybar("5 ℏ")).toBe(B(500_000_000));
    expect(() => hbarToTinybar("0.000000001")).toThrow();
    expect(() => hbarToTinybar("abc")).toThrow();
    expect(() => hbarToTinybar("")).toThrow();
  });

  it("formatHbar trims zeros", () => {
    expect(formatHbar(B(50_000_000))).toBe("0.5 ℏ");
    expect(formatHbar(B(2_500_000_000))).toBe("25 ℏ");
    expect(formatHbar(B(1))).toBe("0.00000001 ℏ");
    expect(formatHbar(B(-150_000_000))).toBe("-1.5 ℏ");
    expect(formatHbar(B(0), { symbol: false })).toBe("0");
    for (const s of ["0.5", "25", "1.23456789"]) expect(formatHbar(hbarToTinybar(s), { symbol: false })).toBe(s);
  });
});

describe("hashscan", () => {
  it("normalizes Hedera tx ids", () => {
    expect(normalizeTxId("0.0.5@1.2")).toBe("0.0.5-1-2");
    expect(normalizeTxId("0.0.5@1700000000.000000001")).toBe("0.0.5-1700000000-000000001");
    expect(normalizeTxId("0.0.5-1-2")).toBe("0.0.5-1-2");
  });

  it("builds testnet urls", () => {
    expect(txUrl("0.0.5@1700000000.000000001")).toBe("https://hashscan.io/testnet/transaction/0.0.5-1700000000-000000001");
    const hash = `0x${"ab".repeat(32)}`;
    expect(txUrl(hash)).toBe(`https://hashscan.io/testnet/transaction/${hash}`);
    expect(accountUrl("0.0.1234")).toBe("https://hashscan.io/testnet/account/0.0.1234");
    expect(contractUrl("0x5e1e6e0000000000000000000000000000000001")).toBe(
      "https://hashscan.io/testnet/contract/0x5e1e6e0000000000000000000000000000000001",
    );
    expect(topicUrl("0.0.777")).toBe("https://hashscan.io/testnet/topic/0.0.777");
  });

  it("treats stub refs as non-links", () => {
    expect(isStubRef("stub:0.0.0@1700000000000.1")).toBe(true);
    expect(isStubRef("stub:x402@1700000000000")).toBe(true);
    expect(isStubRef("0.0.stub-castle_1")).toBe(true);
    expect(isStubRef("0.0.stub-agent-3")).toBe(true);
    expect(isStubRef("0.0.1234")).toBe(false);
    expect(isStubRef(null)).toBe(false);
    expect(txUrl("stub:0.0.0@1.1")).toBe("#stub");
    expect(topicUrl("0.0.stub-castle_1")).toBe("#stub");
    expect(accountUrl("0.0.stub-treasury")).toBe("#stub");
  });
});
