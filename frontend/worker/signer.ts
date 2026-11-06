import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { env } from "@/lib/config/env";
import { DEV_VERIFIER_KEY, rawEcdsaKey, type ReleaseTypedData } from "@/lib/chain/releaseSig";

/**
 * The verifier signer. VERIFIER_KEY is read ONLY here, in the worker process (eslint forbids it in
 * app/** and components/**). Stub mode falls back to the well-known dev key; testnet requires the env.
 * Keep VERIFIER_KEY different from HEDERA_OPERATOR_KEY: arena key + verifier key together can pay any pot.
 */

let cached: { key: string; account: PrivateKeyAccount } | null = null;

function verifierKeyHex(): `0x${string}` {
  const e = env();
  if (e.VERIFIER_KEY) return rawEcdsaKey(e.VERIFIER_KEY);
  if (e.CHAIN_MODE === "stub") return DEV_VERIFIER_KEY;
  throw new Error("Missing env VERIFIER_KEY: the worker cannot sign releases when CHAIN_MODE=testnet");
}

export function verifierSigner(): PrivateKeyAccount {
  const key = verifierKeyHex();
  if (!cached || cached.key !== key) cached = { key, account: privateKeyToAccount(key) };
  return cached.account;
}

export function signReleaseTypedData(typedData: ReleaseTypedData): Promise<`0x${string}`> {
  return verifierSigner().signTypedData(typedData);
}
