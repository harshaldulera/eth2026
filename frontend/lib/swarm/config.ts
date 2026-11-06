/**
 * Swarm (Lane C) configuration. Read from process.env directly so lib/config/env.ts (Lane A) stays
 * untouched. Server only: SWARM_TRANSCRIPT_SECRET must never reach the browser.
 *
 *   SWARM_MODE               stub | live   (default stub; the default port is always stub under the test runner)
 *   SWARM_GATEWAY_URL        a Bee API (node or gateway). Default: Swarm's public gateway, which
 *                            stamps uploads with its own batch, so no stamp of ours is needed.
 *   SWARM_POSTAGE_BATCH_ID   the batch id sent with every upload. Default: the null stamp (all
 *                            zeros), which the public gateway replaces with its own. Set a real
 *                            batch id when uploading through your own Bee node.
 *   SWARM_TRANSCRIPT_SECRET  32 bytes hex. Every transcript is encrypted with a key derived from
 *                            this and the siege id before it leaves the server. Required for live.
 */

export const PUBLIC_GATEWAY = "https://api.gateway.ethswarm.org";
/** The batch id the public gateway accepts and swaps for its own. */
export const NULL_BATCH_ID = "0".repeat(64);

export type SwarmConfig = {
  mode: "stub" | "live";
  gatewayUrl: string;
  batchId: string;
  /** Present only when valid (64 hex chars). */
  secret?: string;
  /** Why live was asked for but refused, for the startup line. */
  refused?: string;
};

const HEX64 = /^[0-9a-fA-F]{64}$/;

export function swarmConfig(e: Record<string, string | undefined> = process.env): SwarmConfig {
  const wantsLive = (e.SWARM_MODE ?? "stub").trim().toLowerCase() === "live";
  const rawSecret = (e.SWARM_TRANSCRIPT_SECRET ?? "").trim().replace(/^0x/, "");
  const secret = HEX64.test(rawSecret) ? rawSecret.toLowerCase() : undefined;
  const rawBatch = (e.SWARM_POSTAGE_BATCH_ID ?? "").trim().replace(/^0x/, "");
  const batchId = HEX64.test(rawBatch) ? rawBatch.toLowerCase() : NULL_BATCH_ID;
  const gatewayUrl = ((e.SWARM_GATEWAY_URL ?? "").trim() || PUBLIC_GATEWAY).replace(/\/+$/, "");
  let refused: string | undefined;
  if (wantsLive && !secret) refused = "SWARM_TRANSCRIPT_SECRET is missing or not 32 bytes of hex (openssl rand -hex 32)";
  else if (wantsLive && e.VITEST) refused = "the test runner never uploads";
  return { mode: wantsLive && !refused ? "live" : "stub", gatewayUrl, batchId, secret, refused };
}

export const isSwarmLive = () => swarmConfig().mode === "live";

/** Public links for a reference: the gateway's own and bzz.limo (a second, independent gateway). */
export const swarmLinks = {
  bytes: (ref: string, gateway = swarmConfig().gatewayUrl) => `${gateway}/bytes/${ref}`,
  limo: (ref: string) => `https://bzz.limo/bytes/${ref}`,
};
