import { domainSeparator, keccak256, toBytes, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { env } from "@/lib/config/env";

/**
 * EIP-712 Release, byte-for-byte what SiegeVault.release() checks:
 *   domain  { name: "SiegeVault", version: "2", chainId, verifyingContract: vault }
 *   Release(uint256 vaultId,address operator,bytes32 transcriptHash,bytes32 opId)
 * Version 2 is the game-vocabulary contract; a version-1 signature never verifies against it.
 */

export const RELEASE_TYPES = {
  Release: [
    { name: "vaultId", type: "uint256" },
    { name: "operator", type: "address" },
    { name: "transcriptHash", type: "bytes32" },
    { name: "opId", type: "bytes32" },
  ],
} as const;

export type ReleaseTypedData = {
  domain: { name: "SiegeVault"; version: "2"; chainId: number; verifyingContract: `0x${string}` };
  types: typeof RELEASE_TYPES;
  primaryType: "Release";
  message: { vaultId: bigint; operator: `0x${string}`; transcriptHash: `0x${string}`; opId: `0x${string}` };
};

/** The Release type string the contract hashes into RELEASE_TYPEHASH, from RELEASE_TYPES. */
export function releaseTypeString(): string {
  return `Release(${RELEASE_TYPES.Release.map((f) => `${f.type} ${f.name}`).join(",")})`;
}

/**
 * Whether a deployed SiegeVault checks the Release this app signs. Pass what the contract returns
 * for RELEASE_TYPEHASH and DOMAIN_SEPARATOR. A contract from before the game-vocabulary rename has
 * the same function selectors (only names changed), so it would accept every other call and refuse
 * only the payouts, with BadSignature: this is the check that catches it. Empty = compatible.
 */
export function releaseCompatProblems(p: { chainId: number; vault: `0x${string}`; typehash: Hex; domainSeparator: Hex }): string[] {
  const out: string[] = [];
  const wantType = keccak256(toBytes(releaseTypeString()));
  if (p.typehash.toLowerCase() !== wantType.toLowerCase())
    out.push(`SiegeVault ${p.vault} hashes a different Release type than this app signs (${releaseTypeString()}): an older deployment? Redeploy it (contracts/README.md).`);
  const domain = releaseTypedData({ chainId: p.chainId, vault: p.vault, vaultId: BigInt(0), operator: p.vault, transcriptHash: `0x${"00".repeat(32)}`, opId: "" }).domain;
  if (p.domainSeparator.toLowerCase() !== domainSeparator({ domain }).toLowerCase())
    out.push(`SiegeVault ${p.vault} has a different EIP-712 domain than this app signs (SiegeVault v${domain.version}, chain ${p.chainId}).`);
  return out;
}

/** Anvil key #1. Stub mode ONLY, when VERIFIER_KEY is unset. Never fund its address. */
export const DEV_VERIFIER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

/** Stand-in vault address for stub mode (no contract deployed). */
export const STUB_VAULT_ADDRESS = "0x5e1e6e0000000000000000000000000000000001" as const;

/** The app's op (siege) id -> the bytes32 opId the contract sees. */
export function opIdToBytes32(id: string): `0x${string}` {
  return keccak256(toBytes(id));
}

export function releaseTypedData(p: {
  chainId: number;
  vault: `0x${string}`;
  vaultId: bigint;
  operator: `0x${string}`;
  transcriptHash: `0x${string}`;
  /** The app's op (siege) id; hashed to the contract's bytes32 opId. */
  opId: string;
}): ReleaseTypedData {
  return {
    domain: { name: "SiegeVault", version: "2", chainId: p.chainId, verifyingContract: p.vault },
    types: RELEASE_TYPES,
    primaryType: "Release",
    message: {
      vaultId: p.vaultId,
      operator: p.operator,
      transcriptHash: p.transcriptHash,
      opId: opIdToBytes32(p.opId),
    },
  };
}

/** Accepts "0x"+64 hex, 64 hex, or a DER-encoded secp256k1 key (Hedera portal "DER" format). */
export function rawEcdsaKey(key: string): Hex {
  const k = key.trim().replace(/^0x/i, "");
  if (/^[0-9a-fA-F]{64}$/.test(k)) return `0x${k.toLowerCase()}`;
  // PKCS#8 DER: 3030020100300706052b8104000a04220420 <32 bytes>
  const der = /^3030020100300706052b8104000a04220420([0-9a-fA-F]{64})$/i.exec(k);
  if (der) return `0x${der[1].toLowerCase()}`;
  // SEC1 DER: 302e0201010420 <32 bytes> a00706052b8104000a
  const sec1 = /^302e0201010420([0-9a-fA-F]{64})a00706052b8104000a$/i.exec(k);
  if (sec1) return `0x${sec1[1].toLowerCase()}`;
  throw new Error("Unrecognised ECDSA private key format (expected 0x-hex or secp256k1 DER)");
}

function verifierKey(): Hex | null {
  const e = env();
  if (e.VERIFIER_KEY) return rawEcdsaKey(e.VERIFIER_KEY);
  if (e.CHAIN_MODE === "stub") return DEV_VERIFIER_KEY;
  return null;
}

/** The address the contract trusts: VERIFIER_ADDRESS, else VERIFIER_KEY's address, else (stub only) the dev key's. */
export function verifierAddress(): `0x${string}` {
  const e = env();
  if (e.VERIFIER_ADDRESS) return e.VERIFIER_ADDRESS as `0x${string}`;
  const key = verifierKey();
  if (!key) throw new Error("Missing env VERIFIER_ADDRESS / VERIFIER_KEY (required when CHAIN_MODE=testnet)");
  return privateKeyToAccount(key).address;
}

/**
 * Worker only: the verifier signer (VERIFIER_KEY, or the dev key in stub mode).
 * Never call from app/ routes.
 */
export function verifierAccount(): PrivateKeyAccount {
  const key = verifierKey();
  if (!key) throw new Error("Missing env VERIFIER_KEY (required to sign releases when CHAIN_MODE=testnet)");
  return privateKeyToAccount(key);
}

/** Worker only: sign a Release with the verifier key. */
export function signRelease(typedData: ReleaseTypedData): Promise<`0x${string}`> {
  return verifierAccount().signTypedData(typedData);
}
