import type { Asset } from "@/lib/types";
import { env } from "@/lib/config/env";

/** The asset sieges are paid in (HBAR "0.0.0" by default; HTS USDC "0.0.429274" later). */
export function asset(): Asset {
  const e = env();
  return { id: e.X402_ASSET, decimals: e.X402_ASSET_DECIMALS, symbol: e.X402_ASSET_SYMBOL };
}

/** CAIP-2 network the x402 payment runs on, e.g. "hedera:testnet". */
export function payNetwork(): `${string}:${string}` {
  return env().X402_NETWORK as `${string}:${string}`;
}
