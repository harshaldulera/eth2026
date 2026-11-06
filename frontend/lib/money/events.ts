import type { Amount, FeeSplit, StoredSiegeEvent, SiegeEvent, TxRef } from "@/lib/types";

/**
 * Tolerant readers for money-carrying event payloads (pure). The worker emits "attempt" and
 * "release" events; these accept the documented shape and a few obvious variants so the UI does
 * not break if a field moves.
 *
 *   attempt: { split: { castellan, pot, arena }, newPot, txId, hashscanUrl?, stub?, streak? }
 *   release: { amount, raider, txId, hashscanUrl?, stub? }
 */

type P = Record<string, unknown>;

const str = (v: unknown): string | undefined =>
  typeof v === "string" && v ? v : typeof v === "number" || typeof v === "bigint" ? String(v) : undefined;

function txFrom(p: P): TxRef | undefined {
  const nested = (p.tx ?? null) as P | null;
  const txId = str(p.txId) ?? (nested ? str(nested.txId) : undefined);
  if (!txId) return undefined;
  const hashscanUrl = str(p.hashscanUrl) ?? (nested ? str(nested.hashscanUrl) : undefined) ?? "#stub";
  const stub = Boolean(p.stub ?? nested?.stub) || txId.startsWith("stub:");
  return { txId, hashscanUrl, stub };
}

export function parseAttempt(payload: P | undefined): { split?: FeeSplit; newPot?: Amount; tx?: TxRef; streak?: number } {
  if (!payload) return {};
  const s = (payload.split ?? payload) as P;
  const castellan = str(s.castellan ?? s.castellanCut);
  const pot = str(s.pot ?? s.potCut);
  const arena = str(s.arena ?? s.arenaCut);
  const split = castellan && pot && arena ? { castellan, pot, arena } : undefined;
  return {
    split,
    newPot: str(payload.newPot),
    tx: txFrom(payload),
    streak: typeof payload.streak === "number" ? payload.streak : undefined,
  };
}

export function parseRelease(payload: P | undefined): { amount?: Amount; raider?: string; tx?: TxRef } {
  if (!payload) return {};
  return { amount: str(payload.amount), raider: str(payload.raider), tx: txFrom(payload) };
}

/** Latest event of a type (events in ascending order). */
export function lastOf<T extends SiegeEvent | StoredSiegeEvent>(events: T[], type: SiegeEvent["type"]): T | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === type) return events[i];
  return undefined;
}
