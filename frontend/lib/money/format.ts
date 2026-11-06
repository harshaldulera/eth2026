import type { Amount, Asset } from "@/lib/types";

/**
 * Money formatting. Pure (no env, no "use client"): safe on server, client, worker and in tests.
 * Amounts on the wire are smallest-unit integer strings (tinybars for HBAR: 1 ℏ = 100_000_000).
 */

export const HBAR: Asset = { id: "0.0.0", decimals: 8, symbol: "HBAR" };

export type FormatOpts = {
  /** Max fraction digits shown (default 4; trailing zeros trimmed down to `minDecimals`). */
  maxDecimals?: number;
  /** Keep at least this many fraction digits (default 0): `{minDecimals: 2, maxDecimals: 2}` → "25.00". */
  minDecimals?: number;
  /** Append the symbol (default true). */
  symbol?: boolean;
  /** Prefix "+" for positive amounts (for deltas like "+0.15 ℏ"). */
  sign?: boolean;
};

/** Accepts an Amount string, bigint or number of smallest units. Garbage becomes 0n. */
export function toUnits(amount: Amount | bigint | number | null | undefined): bigint {
  if (amount === null || amount === undefined) return BigInt(0);
  if (typeof amount === "bigint") return amount;
  if (typeof amount === "number") return Number.isFinite(amount) ? BigInt(Math.trunc(amount)) : BigInt(0);
  const s = amount.trim();
  return /^-?\d+$/.test(s) ? BigInt(s) : BigInt(0);
}

export function isHbar(asset?: Asset): boolean {
  return !asset || asset.id === "0.0.0" || asset.symbol.toUpperCase() === "HBAR";
}

/** Symbol shown after a number: "ℏ" for HBAR, otherwise the asset symbol ("USDC"). */
export function assetSymbol(asset?: Asset): string {
  return isHbar(asset) ? "ℏ" : asset!.symbol;
}

/** Smallest units -> decimal number (lossy, only for animation/ratios). */
export function toNumber(amount: Amount | bigint | number, asset: Asset = HBAR): number {
  return Number(toUnits(amount)) / 10 ** asset.decimals;
}

/**
 * 50_000_000 -> "0.5 ℏ", 2_500_000_000 -> "25 ℏ", 123_456_789 -> "1.2346 ℏ".
 * USDC (6 decimals): 1_500_000 -> "1.5 USDC". Rounds half-up to `maxDecimals`.
 */
export function formatAmount(amount: Amount | bigint | number, asset: Asset = HBAR, opts: FormatOpts = {}): string {
  const { maxDecimals = 4, minDecimals = 0, symbol = true, sign = false } = opts;
  const units = toUnits(amount);
  const neg = units < BigInt(0);
  let abs = neg ? -units : units;
  const decimals = Math.max(0, asset.decimals);
  const shown = Math.min(maxDecimals, decimals);
  // round half-up at `shown` digits
  const drop = BigInt(10) ** BigInt(decimals - shown);
  if (drop > BigInt(1)) abs = ((abs + drop / BigInt(2)) / drop) * drop;
  const base = BigInt(10) ** BigInt(decimals);
  const whole = abs / base;
  const keep = Math.min(Math.max(0, minDecimals), shown);
  const fracRaw = decimals > 0 ? (abs % base).toString().padStart(decimals, "0").slice(0, shown) : "";
  const trimmed = fracRaw.replace(/0+$/, "");
  const frac = trimmed.length >= keep ? trimmed : fracRaw.slice(0, keep);
  const wholeStr = whole.toLocaleString("en-US");
  const num = `${neg ? "-" : sign && units > BigInt(0) ? "+" : ""}${wholeStr}${frac ? `.${frac}` : ""}`;
  return symbol ? `${num} ${assetSymbol(asset)}` : num;
}

/** Format a plain decimal number of whole tokens (used by count-up animations). */
export function formatDecimal(value: number, asset: Asset = HBAR, opts: FormatOpts = {}): string {
  const { maxDecimals = 4, symbol = true } = opts;
  const num = value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: Math.min(maxDecimals, asset.decimals),
  });
  return symbol ? `${num} ${assetSymbol(asset)}` : num;
}

/** "0.0.5@1700000000.000000001" -> "0.0.5@1700…0001"; "0xabc…" -> "0xabcd…ef12"; stub ids kept short. */
export function shortTx(id: string | null | undefined): string {
  if (!id) return "";
  if (id.startsWith("0x")) return id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
  const at = id.indexOf("@");
  if (at >= 0) {
    const acct = id.slice(0, at);
    const ts = id.slice(at + 1);
    return ts.length > 9 ? `${acct}@${ts.slice(0, 4)}…${ts.slice(-4)}` : id;
  }
  return id.length > 22 ? `${id.slice(0, 10)}…${id.slice(-6)}` : id;
}

/** "0.0.1234567" stays; EVM addresses shorten to "0x12ab…cd34". */
export function shortAccount(id: string | null | undefined): string {
  if (!id) return "";
  if (id.startsWith("0x") && id.length > 12) return `${id.slice(0, 6)}…${id.slice(-4)}`;
  return id.length > 20 ? `${id.slice(0, 12)}…${id.slice(-4)}` : id;
}

/** "120 seconds ago" style relative time, coarse (for lists). */
export function timeAgo(iso: string | number | undefined, now: number = Date.now()): string {
  if (iso === undefined || !(now > 0)) return "";
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** 72 -> "1:12" */
export function formatElapsed(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
