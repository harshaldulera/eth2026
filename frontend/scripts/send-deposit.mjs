#!/usr/bin/env node
/**
 * Send a Siege deposit (HBAR + memo) from any Hedera testnet account you hold the key for,
 * e.g. one created on portal.hedera.com. Nothing is stored; the key is read from the environment.
 *
 *   FROM_ID=0.0.12345 FROM_KEY=<private key> TO=0.0.11329863 AMOUNT=10 MEMO=siege:abcd2345 \
 *     node scripts/send-deposit.mjs
 *
 * FROM_KEY: the portal's "DER Encoded Private Key" (starts 3030… / 302e…) or its HEX key (0x… or 64 hex chars, ECDSA).
 */
import { AccountId, Client, Hbar, PrivateKey, TransferTransaction } from "@hiero-ledger/sdk";

const need = (k) => {
  const v = process.env[k]?.trim();
  if (!v) {
    console.error(`missing ${k}`);
    process.exit(1);
  }
  return v;
};
const fromId = AccountId.fromString(need("FROM_ID"));
const rawKey = need("FROM_KEY");
const to = AccountId.fromString(need("TO"));
const amount = Number(need("AMOUNT"));
const memo = need("MEMO");
if (!(amount > 0)) {
  console.error("AMOUNT must be a positive number of HBAR");
  process.exit(1);
}
if (!/^siege:[a-z0-9]{8}$/i.test(memo)) console.warn(`warning: memo "${memo}" does not look like siege:xxxxxxxx`);

const key = /^30[0-9a-f]{2}/i.test(rawKey) ? PrivateKey.fromStringDer(rawKey) : PrivateKey.fromStringECDSA(rawKey.replace(/^0x/i, ""));
const client = Client.forTestnet().setOperator(fromId, key);

console.log(`sending ${amount} ℏ from ${fromId} to ${to} with memo "${memo}" (testnet)…`);
const tx = await new TransferTransaction()
  .addHbarTransfer(fromId, new Hbar(-amount))
  .addHbarTransfer(to, new Hbar(amount))
  .setTransactionMemo(memo)
  .execute(client);
const receipt = await tx.getReceipt(client);
const id = tx.transactionId.toString();
console.log(`status ${receipt.status.toString()}`);
console.log(`tx ${id}`);
console.log(`https://hashscan.io/testnet/transaction/${id.replace("@", "-").replace(/\.(\d+)$/, "-$1")}`);
client.close();
