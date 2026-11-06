import { drainAudit, type DrainReport } from "@/lib/chain";
import { log } from "./log";

/**
 * The HCS audit drainer (lib/chain/outbox.ts): the only place audit messages are submitted. Each pass
 * turns new siege events into queued rows, then sends every castle topic's queue strictly in order,
 * one receipt at a time. A failing topic stops for this pass and is retried on the next; others go on,
 * and a slow one keeps draining in the background while later passes serve the rest.
 */

const g = globalThis as unknown as { __siegeAuditFailLog?: Map<string, number> };
const lastFailLog = (g.__siegeAuditFailLog ??= new Map<string, number>());
const FAIL_LOG_EVERY_MS = 30_000;

export async function auditTick(opts: Parameters<typeof drainAudit>[0] = {}): Promise<DrainReport> {
  const r = await drainAudit(opts);
  if (r.repaired > 0) {
    log.fail(
      `hcs outbox: settled ${r.repaired} audit row(s) written without a queue position by a pre-outbox process (marked submitted/skipped, not re-sent). Stop that old worker: it submits inline, out of order.`,
    );
  }
  for (const s of r.submitted) {
    lastFailLog.delete(s.topicId);
    log.info(`hcs ${s.topicId} #${s.seq} ${s.type}${s.txId ? ` (${s.txId})` : ""}`);
  }
  const now = Date.now();
  for (const f of r.failed) {
    // A topic that keeps failing (network down) is retried every pass; say so every 30 s, not every second.
    if (now - (lastFailLog.get(f.topicId) ?? 0) < FAIL_LOG_EVERY_MS) continue;
    lastFailLog.set(f.topicId, now);
    log.fail(`hcs ${f.topicId} local #${f.localSeq} ${f.type}: ${f.error} — topic paused, retrying next pass`);
  }
  return r;
}
