import {
  AccountId,
  Client,
  PrecheckStatusError,
  PrivateKey,
  ReceiptStatusError,
  Status,
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TransactionId,
} from "@hiero-ledger/sdk";
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

/**
 * A submit that failed. `inDoubt: false` = the message certainly did not reach the topic (refused before
 * sending, rejected at precheck, or reached consensus with a failure status); `inDoubt: true` = it may
 * have (timeout, network error after sending, a DUPLICATE_TRANSACTION precheck on an SDK retry): the
 * audit outbox asks the mirror node before resending.
 */
export class HcsSubmitError extends Error {
  constructor(
    message: string,
    readonly inDoubt: boolean,
  ) {
    super(message);
    this.name = "HcsSubmitError";
  }
}

/** A fresh transaction id for the arena operator ("0.0.x@sec.nanos"), generated before the submit so it can be looked up later. */
export function newTxId(): string {
  return TransactionId.generate(AccountId.fromString(required("HEDERA_OPERATOR_ID"))).toString();
}

const msgOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Whether an error thrown by execute() leaves the submit in doubt. A precheck rejection means the node
 * refused it, so it did not reach consensus, EXCEPT DUPLICATE_TRANSACTION: the SDK retries a gRPC
 * timeout / unavailable on the next node with the same tx id, and that node answers DUPLICATE_TRANSACTION
 * when the first one had already accepted it. The message may well land, so the outbox keeps the tx id
 * and asks the mirror node instead of resending it under a new one.
 */
export function executeErrorInDoubt(e: unknown): boolean {
  if (!(e instanceof PrecheckStatusError)) return true;
  return e.status === Status.DuplicateTransaction || e.status?.toString() === "DUPLICATE_TRANSACTION";
}

/**
 * Submit one message (<= 1000 bytes) and wait for its receipt. Returns the topic sequence number.
 * Pass `txId` (from newTxId) so an in-doubt submit can be reconciled; throws HcsSubmitError.
 */
export async function submit(
  topicId: string,
  message: string | Record<string, unknown>,
  opts: { txId?: string } = {},
): Promise<{ seq: number; txId: string }> {
  const text = typeof message === "string" ? message : JSON.stringify(message);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > HCS_MAX_BYTES) throw new HcsSubmitError(`HCS message too large: ${bytes} > ${HCS_MAX_BYTES} bytes`, false);
  let client: Client;
  let tx: TopicMessageSubmitTransaction;
  try {
    client = hederaClient();
    tx = new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(text);
    if (opts.txId) tx.setTransactionId(TransactionId.fromString(opts.txId));
  } catch (e) {
    throw new HcsSubmitError(msgOf(e), false);
  }
  let resp;
  try {
    resp = await tx.execute(client);
  } catch (e) {
    throw new HcsSubmitError(msgOf(e), executeErrorInDoubt(e));
  }
  let receipt;
  try {
    receipt = await resp.getReceipt(client);
  } catch (e) {
    throw new HcsSubmitError(msgOf(e), !(e instanceof ReceiptStatusError));
  }
  const seq = receipt.topicSequenceNumber;
  return { seq: seq == null ? 0 : Number(seq.toString()), txId: resp.transactionId.toString() };
}
