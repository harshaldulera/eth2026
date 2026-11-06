/**
 * npm run arkiv:check — verify the Arkiv (Rabdi testnet) setup without printing any secret.
 *
 * Checks: ARKIV_PRIVATE_KEY is a valid key, the RPC answers with the Rabdi chain id, the wallet
 * holds tGLM for gas, and ARKIV_ACCESS_KEY is accepted by the keyed RPC endpoint.
 * Only the wallet ADDRESS is printed. Secrets are masked in every error message.
 */
import "@/lib/config/load-env";
import { createPublicClient, formatEther, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.ARKIV_RPC_URL || "https://rpc.rabdi.db-chain.testnet.arkiv.network";
const EXPECTED_CHAIN_ID = 7794095;
const EXPLORER = process.env.ARKIV_EXPLORER_URL || "https://rabdi.explorer.arkiv.network";

const rawKey = (process.env.ARKIV_PRIVATE_KEY ?? "").trim();
const accessKey = (process.env.ARKIV_ACCESS_KEY ?? "").trim();

const secrets = [rawKey, rawKey.replace(/^0x/, ""), accessKey].filter((s) => s.length >= 8);
const mask = (s: string) => secrets.reduce((out, sec) => out.split(sec).join("<hidden>"), s);
const errText = (e: unknown) => mask(e instanceof Error ? e.message.split("\n")[0] : String(e));

let failed = 0;
const ok = (msg: string) => console.log(`  PASS  ${msg}`);
const bad = (msg: string, fix?: string) => {
  failed += 1;
  console.log(`  FAIL  ${msg}`);
  if (fix) console.log(`        fix: ${fix}`);
};

async function main() {
  console.log("Arkiv setup check (Rabdi testnet)\n");

  // 1. Private key
  let address: `0x${string}` | undefined;
  if (!rawKey) {
    bad("ARKIV_PRIVATE_KEY is not set", "add ARKIV_PRIVATE_KEY=0x... to frontend/.env");
  } else {
    const key = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      bad(`ARKIV_PRIVATE_KEY is not 64 hex characters (got ${key.length - 2})`, "re-copy it from MetaMask; no quotes or spaces");
    } else {
      address = privateKeyToAccount(key).address;
      ok(`private key is valid → wallet ${address}`);
      if (!rawKey.startsWith("0x")) console.log("        note: key has no 0x prefix; the app will add it");
    }
  }

  // 2. Public RPC + chain id
  const pub = createPublicClient({ transport: http(RPC, { timeout: 15_000, retryCount: 0 }) });
  try {
    const id = await pub.getChainId();
    if (id === EXPECTED_CHAIN_ID) ok(`public RPC reachable, chain id ${id} (Rabdi)`);
    else bad(`RPC answered chain id ${id}, expected ${EXPECTED_CHAIN_ID}`, "check ARKIV_RPC_URL");
  } catch (e) {
    bad(`public RPC unreachable: ${errText(e)}`, "check your internet, then https://status.arkiv.network");
  }

  // 3. Balance
  if (address) {
    try {
      const wei = await pub.getBalance({ address });
      if (wei > BigInt(0)) ok(`wallet holds ${formatEther(wei)} tGLM`);
      else bad("wallet balance is 0 tGLM", `claim at https://hub.arkiv.network/faucet with ${address}`);
    } catch (e) {
      bad(`could not read balance: ${errText(e)}`);
    }
  }

  // 4. Access key: call the keyed endpoint (key in the URL path, per the Arkiv docs)
  if (!accessKey) {
    bad("ARKIV_ACCESS_KEY is not set", "generate one at https://hub.arkiv.network/access-keys (network: Rabdi)");
  } else {
    const keyed = createPublicClient({
      transport: http(`${RPC.replace(/\/$/, "")}/${accessKey}`, { timeout: 15_000, retryCount: 0 }),
    });
    try {
      const [id, block] = await Promise.all([keyed.getChainId(), keyed.getBlockNumber()]);
      if (id === EXPECTED_CHAIN_ID) ok(`access key accepted (keyed RPC at block ${block})`);
      else bad(`keyed RPC answered chain id ${id}`, "the key may be for another network; pick Rabdi in the Hub");
    } catch (e) {
      bad(`access key rejected: ${errText(e)}`, "re-copy the key from https://hub.arkiv.network/access-keys; make sure it is for Rabdi");
    }
  }

  if (address) console.log(`\n  explorer: ${EXPLORER}/address/${address}`);
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll checks passed. Arkiv is ready.");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`unexpected error: ${errText(e)}`);
  process.exit(1);
});
