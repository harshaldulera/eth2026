/**
 * Deploy SiegeVault to Hedera testnet through the JSON-RPC relay.
 *   npx tsx scripts/deploy-vault.ts           (needs CHAIN_MODE=testnet)
 *   npx tsx scripts/deploy-vault.ts --force   (deploy even while CHAIN_MODE=stub)
 *
 * arena    = address of HEDERA_OPERATOR_KEY (ECDSA)
 * verifier = VERIFIER_ADDRESS, else the address of VERIFIER_KEY
 * bps      = FEE_SPLIT_CASTELLAN_BPS / FEE_SPLIT_POT_BPS / FEE_SPLIT_ARENA_BPS
 * Prints VAULT_ADDRESS=0x… for .env.local and the HashScan link.
 */
import "@/lib/config/load-env";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "@/lib/config/env";
import { siegeVaultAbi, siegeVaultBytecode } from "@/lib/chain/abi/SiegeVault";
import { arenaAccount, evmChain, publicClient, walletClient } from "@/lib/chain/evm";
import { contractUrl, txUrl } from "@/lib/chain/hashscan";
import { rawEcdsaKey } from "@/lib/chain/releaseSig";
import { formatHbar, weiToTinybar } from "@/lib/chain/units";

async function main() {
  const e = env();
  const force = process.argv.includes("--force");
  if (e.CHAIN_MODE === "stub" && !force) {
    console.error("CHAIN_MODE=stub: refusing to deploy. Set CHAIN_MODE=testnet (or pass --force).");
    process.exit(1);
  }

  const arena = arenaAccount().address;
  const verifier = (e.VERIFIER_ADDRESS ?? (e.VERIFIER_KEY ? privateKeyToAccount(rawEcdsaKey(e.VERIFIER_KEY)).address : undefined)) as
    | `0x${string}`
    | undefined;
  if (!verifier) {
    console.error("Missing VERIFIER_ADDRESS or VERIFIER_KEY.");
    process.exit(1);
  }
  const bps = [e.FEE_SPLIT_CASTELLAN_BPS, e.FEE_SPLIT_POT_BPS, e.FEE_SPLIT_ARENA_BPS] as const;
  if (bps[0] + bps[1] + bps[2] !== 10_000) {
    console.error(`Fee split bps must sum to 10000, got ${bps.join(" + ")}.`);
    process.exit(1);
  }

  const chain = evmChain();
  const balanceWei = await publicClient().getBalance({ address: arena });
  console.log(`chain     ${chain.name} (${chain.id}) via ${e.HEDERA_RPC_URL}`);
  console.log(`arena     ${arena}  balance ${formatHbar(weiToTinybar(balanceWei - (balanceWei % BigInt(10_000_000_000))))}`);
  console.log(`verifier  ${verifier}`);
  console.log(`split     castellan ${bps[0]} / pot ${bps[1]} / arena ${bps[2]} bps`);

  const hash = await walletClient().deployContract({
    abi: siegeVaultAbi,
    bytecode: siegeVaultBytecode,
    args: [arena, verifier, bps[0], bps[1], bps[2]],
    gas: BigInt(3_000_000),
  });
  console.log(`deploy tx ${hash}\n          ${txUrl(hash)}`);
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    console.error(`Deploy failed: status=${receipt.status}`);
    process.exit(1);
  }
  const address = receipt.contractAddress;

  // Sanity: read back the immutables.
  const [onArena, onVerifier] = await Promise.all([
    publicClient().readContract({ address, abi: siegeVaultAbi, functionName: "arena" }),
    publicClient().readContract({ address, abi: siegeVaultAbi, functionName: "verifier" }),
  ]);
  if (onArena.toLowerCase() !== arena.toLowerCase() || onVerifier.toLowerCase() !== verifier.toLowerCase()) {
    console.warn(`warning: read-back mismatch arena=${onArena} verifier=${onVerifier}`);
  }

  console.log("\nAdd to frontend/.env.local:\n");
  console.log(`VAULT_ADDRESS=${address}`);
  if (!e.VERIFIER_ADDRESS) console.log(`VERIFIER_ADDRESS=${verifier}`);
  console.log(`\nHashScan: ${contractUrl(address)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
