/**
 * Arkiv clients. SERVER ONLY: the wallet client holds the arena writer key. ESLint forbids
 * importing this file from app/** and components/**.
 */
import { createPublicClient, createWalletClient } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arkivConfig } from "./config";

const g = globalThis as unknown as {
  __arkivClients?: { sig: string; pub: ReturnType<typeof makePublic>; wallet?: ReturnType<typeof makeWallet>; arena?: `0x${string}` };
};

const chain = () => rabdi({ accessKey: arkivConfig().accessKey });
const makePublic = () => createPublicClient({ chain: chain(), transport: http(undefined, { timeout: 8_000, retryCount: 1 }) });
const makeWallet = (pk: `0x${string}`) =>
  createWalletClient({ chain: chain(), transport: http(undefined, { timeout: 30_000, retryCount: 1 }), account: privateKeyToAccount(pk) });

function state() {
  const c = arkivConfig();
  const sig = `${c.accessKey.length}:${c.privateKey?.slice(-6) ?? "-"}`;
  if (!g.__arkivClients || g.__arkivClients.sig !== sig) {
    g.__arkivClients = {
      sig,
      pub: makePublic(),
      wallet: c.privateKey ? makeWallet(c.privateKey) : undefined,
      arena: c.privateKey ? privateKeyToAccount(c.privateKey).address : undefined,
    };
  }
  return g.__arkivClients;
}

/** Reads (queries, getEntity). */
export const arkivReader = () => state().pub;

/** Writes. Throws when ARKIV_PRIVATE_KEY is missing or invalid. */
export function arkivWriter() {
  const w = state().wallet;
  if (!w) throw new Error("ARKIV_PRIVATE_KEY is not set or is not a 32-byte hex key");
  return w;
}

/** The arena wallet: owner of every Siege entity. Queries filter on it. */
export function arenaAddress(): `0x${string}` {
  const a = state().arena;
  if (!a) throw new Error("ARKIV_PRIVATE_KEY is not set or is not a 32-byte hex key");
  return a;
}
