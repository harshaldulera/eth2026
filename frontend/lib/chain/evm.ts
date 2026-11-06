import { createPublicClient, createWalletClient, defineChain, http, type Chain, type PublicClient, type WalletClient, type Transport, type Account } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { hederaTestnet } from "viem/chains";
import { env, required } from "@/lib/config/env";
import { rawEcdsaKey } from "./releaseSig";

/**
 * viem clients for the Hedera JSON-RPC relay. Server only. Created lazily on first use so stub
 * mode never needs an RPC or a key. Values sent through these clients are WEIBARS (tinybar * 1e10).
 */

export const HEDERA_TESTNET_CHAIN_ID = 296;
export const HEDERA_MAINNET_CHAIN_ID = 295;

/** The EVM chain id we sign Releases for: HEDERA_CHAIN_ID, else 295 (mainnet) / 296 (testnet). */
export function configuredChainId(): number {
  const e = env();
  return e.HEDERA_CHAIN_ID ?? (e.HEDERA_NETWORK === "mainnet" ? HEDERA_MAINNET_CHAIN_ID : HEDERA_TESTNET_CHAIN_ID);
}

let chainCache: Chain | null = null;
export function evmChain(): Chain {
  if (chainCache) return chainCache;
  const url = env().HEDERA_RPC_URL;
  const id = configuredChainId();
  chainCache =
    url === hederaTestnet.rpcUrls.default.http[0] && id === HEDERA_TESTNET_CHAIN_ID
      ? hederaTestnet
      : defineChain({ ...hederaTestnet, id, rpcUrls: { default: { http: [url] } } });
  return chainCache;
}

let rpcChainIdCache: Promise<number> | null = null;
/**
 * The chain id the RPC actually serves (read once). SiegeVault bakes block.chainid into its EIP-712
 * domain at deploy, so a Release signed for any other id reverts BadSignature: fail fast instead.
 */
export function rpcChainId(): Promise<number> {
  if (!rpcChainIdCache) {
    rpcChainIdCache = publicClient()
      .getChainId()
      .then((id) => {
        const want = configuredChainId();
        if (id !== want) {
          throw new Error(
            `chain_id_mismatch: ${env().HEDERA_RPC_URL} serves chainId ${id} but HEDERA_NETWORK/HEDERA_CHAIN_ID says ${want}`,
          );
        }
        return id;
      });
    rpcChainIdCache.catch(() => (rpcChainIdCache = null));
  }
  return rpcChainIdCache;
}

let publicCache: PublicClient | null = null;
export function publicClient(): PublicClient {
  return (publicCache ??= createPublicClient({ chain: evmChain(), transport: http(env().HEDERA_RPC_URL, { timeout: 30_000 }) }));
}

let arenaCache: PrivateKeyAccount | null = null;
/** The arena operator's EVM account (HEDERA_OPERATOR_KEY must be ECDSA secp256k1). */
export function arenaAccount(): PrivateKeyAccount {
  return (arenaCache ??= privateKeyToAccount(rawEcdsaKey(required("HEDERA_OPERATOR_KEY"))));
}

export type ArenaWalletClient = WalletClient<Transport, Chain, Account>;
let walletCache: ArenaWalletClient | null = null;
export function walletClient(): ArenaWalletClient {
  return (walletCache ??= createWalletClient({
    account: arenaAccount(),
    chain: evmChain(),
    transport: http(env().HEDERA_RPC_URL, { timeout: 60_000 }),
  }));
}

/** Tests: forget cached clients after env changes. */
export function resetEvm() {
  chainCache = null;
  rpcChainIdCache = null;
  publicCache = null;
  arenaCache = null;
  walletCache = null;
}
