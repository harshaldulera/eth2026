/**
 * HBAR units. Pure, safe to import anywhere.
 *
 *  - 1 HBAR = 100_000_000 tinybars. Contract storage, events, msg.value inside the EVM and our DB
 *    all use tinybars.
 *  - The JSON-RPC relay (Hashio) speaks 18-decimal "weibars": value_wei = tinybars * 1e10.
 *    Never send a value that is not a multiple of 1e10 wei.
 */

export const TINYBAR_PER_HBAR = BigInt(100_000_000);
export const WEI_PER_TINYBAR = BigInt(10_000_000_000);
export const HBAR_DECIMALS = 8;
export const HBAR_SYMBOL = "ℏ";

/** Tinybars -> relay weibars (for `value` on EVM writes). */
export function tinybarToWei(tinybar: bigint): bigint {
  return tinybar * WEI_PER_TINYBAR;
}

/** Relay weibars -> tinybars. Throws on sub-tinybar precision (the relay would reject it). */
export function weiToTinybar(wei: bigint): bigint {
  if (wei % WEI_PER_TINYBAR !== BigInt(0)) {
    throw new Error(`weiToTinybar: ${wei} wei is not a whole number of tinybars`);
  }
  return wei / WEI_PER_TINYBAR;
}

/** "1" -> 100000000n, "0.5" -> 50000000n, "-2.25" -> -225000000n. Max 8 decimals. */
export function hbarToTinybar(hbar: string): bigint {
  const s = hbar.trim().replace(/\s*(ℏ|hbar|HBAR)$/, "");
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`hbarToTinybar: not a number: "${hbar}"`);
  const [, neg, whole, frac = ""] = m;
  if (frac.length > HBAR_DECIMALS) throw new Error(`hbarToTinybar: more than 8 decimals: "${hbar}"`);
  const v = BigInt(whole || "0") * TINYBAR_PER_HBAR + BigInt((frac + "00000000").slice(0, HBAR_DECIMALS));
  return neg ? -v : v;
}

/** 50000000n -> "0.5 ℏ", 2500000000n -> "25 ℏ". Trailing zeros trimmed. */
export function formatHbar(tinybar: bigint, opts: { symbol?: boolean } = {}): string {
  const neg = tinybar < BigInt(0);
  const abs = neg ? -tinybar : tinybar;
  const whole = abs / TINYBAR_PER_HBAR;
  const frac = (abs % TINYBAR_PER_HBAR).toString().padStart(HBAR_DECIMALS, "0").replace(/0+$/, "");
  const num = `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
  return opts.symbol === false ? num : `${num} ${HBAR_SYMBOL}`;
}
