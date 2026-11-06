/**
 * Arkiv (Lane C) configuration. Read from process.env directly so lib/config/env.ts (Lane A) stays
 * untouched. Server only: ARKIV_PRIVATE_KEY and ARKIV_ACCESS_KEY must never reach the browser.
 *
 *   ARKIV_MODE        stub | live   (default stub; tests are always stub)
 *   ARKIV_PRIVATE_KEY arena writer wallet, funded with tGLM (hub.arkiv.network/faucet)
 *   ARKIV_ACCESS_KEY  RPC access key (hub.arkiv.network/access-keys); "" = public, rate-limited RPC
 *   ARKIV_NAMESPACE   prefix of every schema name (default "siege")
 */

export const RABDI = {
  chainId: 7794095,
  rpcUrl: "https://rpc.rabdi.db-chain.testnet.arkiv.network",
  explorerUrl: "https://rabdi.explorer.arkiv.network",
} as const;

export type ArkivConfig = {
  mode: "stub" | "live";
  privateKey?: `0x${string}`;
  accessKey: string;
  namespace: string;
  explorerUrl: string;
};

function normalizeKey(raw: string | undefined): `0x${string}` | undefined {
  const k = raw?.trim();
  if (!k) return undefined;
  const hex = k.startsWith("0x") ? k : `0x${k}`;
  return /^0x[0-9a-fA-F]{64}$/.test(hex) ? (hex as `0x${string}`) : undefined;
}

export function arkivConfig(): ArkivConfig {
  const e = process.env;
  const privateKey = normalizeKey(e.ARKIV_PRIVATE_KEY);
  const wantsLive = (e.ARKIV_MODE ?? "stub").trim().toLowerCase() === "live";
  return {
    // Live needs a valid writer key, and never runs under the test runner.
    mode: wantsLive && privateKey && !e.VITEST ? "live" : "stub",
    privateKey,
    accessKey: (e.ARKIV_ACCESS_KEY ?? "").trim(),
    namespace: (e.ARKIV_NAMESPACE ?? "siege").trim() || "siege",
    explorerUrl: (e.ARKIV_EXPLORER_URL ?? RABDI.explorerUrl).replace(/\/$/, ""),
  };
}

export const isArkivLive = () => arkivConfig().mode === "live";

/** Explorer links for the UI and the docs. */
export const arkivLinks = {
  entity: (key: string) => `${arkivConfig().explorerUrl}/entity/${key}`,
  address: (addr: string) => `${arkivConfig().explorerUrl}/address/${addr}`,
  tx: (hash: string) => `${arkivConfig().explorerUrl}/tx/${hash}`,
};
