import type { Client, PrivateKey } from "@hiero-ledger/sdk";
import { env, required } from "@/lib/config/env";

/**
 * Hedera SDK helpers for the testnet paths. The SDK is imported lazily so stub mode
 * (and every unit test) never loads it.
 */

export async function sdk() {
  return import("@hiero-ledger/sdk");
}

/** Accepts a hex ECDSA key (with or without 0x) or a DER-encoded key ("3030…"). */
export async function parsePrivateKey(key: string): Promise<PrivateKey> {
  const { PrivateKey } = await sdk();
  const k = key.trim();
  if (/^30[0-9a-f]{2,}/i.test(k) && k.length > 66) return PrivateKey.fromStringDer(k);
  return PrivateKey.fromStringECDSA(k.replace(/^0x/, ""));
}

const g = globalThis as unknown as { __siegeHederaOperator?: Promise<Client> };

/** The arena operator client (HEDERA_OPERATOR_ID / HEDERA_OPERATOR_KEY). Cached per process. */
export function operatorClient(): Promise<Client> {
  if (!g.__siegeHederaOperator) {
    g.__siegeHederaOperator = (async () => {
      const { Client, AccountId } = await sdk();
      const id = required("HEDERA_OPERATOR_ID");
      const key = await parsePrivateKey(required("HEDERA_OPERATOR_KEY"));
      const client = env().HEDERA_NETWORK === "mainnet" ? Client.forMainnet() : Client.forTestnet();
      client.setOperator(AccountId.fromString(id), key);
      return client;
    })();
    g.__siegeHederaOperator.catch(() => {
      g.__siegeHederaOperator = undefined;
    });
  }
  return g.__siegeHederaOperator;
}

/** Mirror node lookup of an account's EVM address (long-zero or alias). Null on any failure. */
export async function mirrorEvmAddress(accountId: string): Promise<`0x${string}` | null> {
  try {
    const res = await fetch(`${env().HEDERA_MIRROR_URL}/api/v1/accounts/${accountId}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { evm_address?: string };
    return j.evm_address ? (j.evm_address.toLowerCase() as `0x${string}`) : null;
  } catch {
    return null;
  }
}
