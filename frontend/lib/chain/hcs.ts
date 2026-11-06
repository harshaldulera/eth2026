import { AccountId, Client, PrivateKey, TopicCreateTransaction, TopicMessageSubmitTransaction } from "@hiero-ledger/sdk";
import { env, required } from "@/lib/config/env";

/**
 * Hedera Consensus Service: one audit topic per castle. Server only, testnet mode only.
 * Messages carry hashes and ids, never transcript text or guardian orders.
 */

export const HCS_MAX_BYTES = 1000;

/** Parse an operator key: raw hex (ECDSA) or DER. */
export function parseHederaKey(key: string): PrivateKey {
  const k = key.trim();
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(k)) return PrivateKey.fromStringECDSA(k.replace(/^0x/i, ""));
  return PrivateKey.fromStringDer(k.replace(/^0x/i, ""));
}

let clientCache: Client | null = null;
let keyCache: PrivateKey | null = null;

export function operatorKey(): PrivateKey {
  return (keyCache ??= parseHederaKey(required("HEDERA_OPERATOR_KEY")));
}

/** SDK client with the arena operator. */
export function hederaClient(): Client {
  if (clientCache) return clientCache;
  const e = env();
  const c = e.HEDERA_NETWORK === "mainnet" ? Client.forMainnet() : Client.forTestnet();
  c.setOperator(AccountId.fromString(required("HEDERA_OPERATOR_ID")), operatorKey());
  clientCache = c;
  return c;
}

export async function createTopic(castleId: string): Promise<{ topicId: string; txId: string }> {
  const client = hederaClient();
  const key = operatorKey().publicKey;
  const resp = await new TopicCreateTransaction()
    .setAdminKey(key)
    .setSubmitKey(key)
    .setTopicMemo(`siege:castle:${castleId}`.slice(0, 100))
    .execute(client);
  const receipt = await resp.getReceipt(client);
  if (!receipt.topicId) throw new Error("TopicCreateTransaction returned no topicId");
  return { topicId: receipt.topicId.toString(), txId: resp.transactionId.toString() };
}

/** Submit one message (<= 1000 bytes). Returns the topic sequence number. */
export async function submit(topicId: string, message: string | Record<string, unknown>): Promise<{ seq: number; txId: string }> {
  const text = typeof message === "string" ? message : JSON.stringify(message);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > HCS_MAX_BYTES) throw new Error(`HCS message too large: ${bytes} > ${HCS_MAX_BYTES} bytes`);
  const client = hederaClient();
  const resp = await new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(text).execute(client);
  const receipt = await resp.getReceipt(client);
  const seq = receipt.topicSequenceNumber;
  return { seq: seq == null ? 0 : Number(seq.toString()), txId: resp.transactionId.toString() };
}
