// STUB — Lane B replaces with the 0G proxy (app/api/proxy, per-vault scoped model keys, real request records); keep the signature.
import { createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { keccak256, toBytes } from "viem";
import { db, schema } from "@/lib/db";
import { env } from "@/lib/config/env";
import { nowIso } from "@/lib/util/ids";
import type { ProxyPort, ProxyRecord, ToolCall } from "@/lib/types";

/**
 * The vault-scoped inference proxy (plan B8). Every guardian inference — hosted or an external
 * harness through @siege/guard — goes through a model key issued for ONE vault, and the proxy keeps a
 * request record per call. The verifier (lib/siege/verifier.ts) trusts these records, not whatever a
 * transport reported.
 *
 * Privacy rule: a record holds HASHES and flags only — never the system prompt, the raider's text or
 * the reply. `recordRequest` takes the system prompt only to hash it, and drops it.
 *
 * Stub: keys are deterministic strings (nothing is enforced), records live in `proxy_records`.
 */

export type ProxyKey = { modelKey: string; baseURL: string };

export type RecordRequestInput = {
  /** Vault scope of the model key (the castle id). */
  vaultId: string;
  siegeId?: string;
  turn?: number;
  /** Hashed (keccak256) and discarded. Never stored. */
  systemPrompt: string;
  /** Tool calls carried by the response. Only the names are inspected; nothing is stored. */
  toolCalls: Pick<ToolCall, "name">[];
  /** The castle's protected tool: a call to it is the only thing that marks the response as a break. */
  protectedTool: string;
};

/** keccak256 of the system prompt (UTF-8). The B8 orders-changed check compares these. */
export function promptHash(systemPrompt: string): `0x${string}` {
  return keccak256(toBytes(systemPrompt));
}

/** Deterministic stub key for a vault: "sk-siege-stub-<vaultId>-<16 hex>". */
export function stubModelKey(vaultId: string): string {
  const h = createHash("sha256").update(`siege-proxy-stub:${vaultId}`).digest("hex").slice(0, 16);
  return `sk-siege-stub-${vaultId}-${h}`;
}

/** OpenAI-compatible base URL of the proxy (Lane B's app/api/proxy/v1). */
export function proxyBaseURL(): string {
  return `${env().APP_URL.replace(/\/+$/, "")}/api/proxy/v1`;
}

function toRecord(r: typeof schema.proxyRecords.$inferSelect): ProxyRecord {
  const out: ProxyRecord = {
    requestId: r.requestId,
    vaultId: r.vaultId,
    promptHash: r.promptHash as `0x${string}`,
    protectedToolCalled: r.protectedToolCalled,
    at: r.at,
  };
  if (r.siegeId != null) out.siegeId = r.siegeId;
  if (r.turn != null) out.turn = r.turn;
  return out;
}

async function issueKey(vaultId: string): Promise<ProxyKey> {
  return { modelKey: stubModelKey(vaultId), baseURL: proxyBaseURL() };
}

/**
 * Record one inference request through `vaultId`'s key. Returns the stored record; its `requestId`
 * is what transports put on the GuardianDecision. Ids look like 0G request ids ("0g-stub-<12 hex>")
 * and are unique per call (the proxy sees every request, including retries of the same turn).
 */
export async function recordRequest(i: RecordRequestInput): Promise<ProxyRecord> {
  const requestId = "0g-stub-" + randomBytes(6).toString("hex");
  const row = {
    requestId,
    vaultId: i.vaultId,
    siegeId: i.siegeId ?? null,
    turn: i.turn ?? null,
    promptHash: promptHash(i.systemPrompt),
    protectedToolCalled: i.toolCalls.some((t) => t.name === i.protectedTool),
    at: nowIso(),
  };
  db().insert(schema.proxyRecords).values(row).run();
  return toRecord(row);
}

async function record(requestId: string): Promise<ProxyRecord | null> {
  const r = db().select().from(schema.proxyRecords).where(eq(schema.proxyRecords.requestId, requestId)).get();
  return r ? toRecord(r) : null;
}

/** Every record of one siege, in insertion order (tests / replay). */
export function recordsForSiege(siegeId: string): ProxyRecord[] {
  return db()
    .select()
    .from(schema.proxyRecords)
    .where(eq(schema.proxyRecords.siegeId, siegeId))
    .orderBy(sql`rowid`)
    .all()
    .map(toRecord);
}

export const proxy: ProxyPort & { recordRequest: typeof recordRequest } = { issueKey, record, recordRequest };
