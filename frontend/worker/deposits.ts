/**
 * Deposit loop: every 5 s while an intent is open, read the arena account's incoming transfers from
 * the mirror node, match them to intents by memo and settle (fund) them; retry failed handlers.
 * Stub mode never reads the mirror (createIntent confirms inline), but still retries and expires.
 */
import { env } from "@/lib/config/env";
import { accountTransfers } from "@/lib/chain/mirror";
import {
  MAX_HANDLER_ATTEMPTS,
  depositAccount,
  expireIntents,
  failedIntents,
  matchDeposits,
  openIntents,
  retryFailed,
  settleIntent,
  unstickFunding,
} from "@/lib/pay/deposits";
import { consensusMs } from "@/lib/pay/deposits";
import { expireUnitDrafts } from "@/lib/agents/drafts";
// Deposit handlers (part 1): the worker process must have them registered too.
import "@/lib/publish/handlers";
// Part 2b: "unit" (lib/agents/drafts) and "topup" (lib/pay/approvals) register at import too; named
// here so this loop never depends on worker/agents.ts happening to load them first.
import "@/lib/agents/drafts";
import "@/lib/pay/approvals";
import { log } from "./log";

const EVERY_MS = 5_000;
const RETRY_BACKOFF_MS = 30_000;
/** Look this far before the oldest open intent (clock skew, mirror lag). */
const LOOKBACK_MS = 120_000;
let last = 0;
let lastSweep = 0;
const SWEEP_EVERY_MS = 60_000;
const lastTry = new Map<string, number>();
/**
 * Per deposit account: the newest consensus time already read. Each pass reads forward from it (less
 * LOOKBACK_MS), so a busy account (x402 op fees are CRYPTOTRANSFERs too) never pins the read to the
 * oldest watched intent: past the mirror's page cap the next pass simply continues where this one stopped.
 */
const highWater = new Map<string, number>();

/** Tests: forget the throttle and retry clocks. */
export function resetDepositsTick(): void {
  last = 0;
  lastSweep = 0;
  lastTry.clear();
  highWater.clear();
}

export async function depositsTick(now = Date.now()): Promise<number> {
  let acted = 0;
  if (now - lastSweep >= SWEEP_EVERY_MS) {
    lastSweep = now;
    // A handler whose process died mid-setup: back to failed (resumable), then retried below.
    const stuck = unstickFunding(now);
    if (stuck) log.info(`deposits: ${stuck} interrupted setup(s) will be retried`);
    const gone = await expireUnitDrafts(now).catch(() => 0);
    if (gone) log.info(`deposits: ${gone} unit draft(s) expired`);
    acted += stuck + gone;
  }
  const failed = failedIntents();
  const open = openIntents(now);
  if (!failed.length && !open.length) return acted;
  if (now - last < EVERY_MS) return acted;
  last = now;

  for (const f of failed) {
    if (f.attempts >= MAX_HANDLER_ATTEMPTS) continue;
    if (now - (lastTry.get(f.id) ?? 0) < RETRY_BACKOFF_MS) continue;
    lastTry.set(f.id, now);
    const s = await retryFailed(f.id, now);
    if (s) {
      acted++;
      log.info(`deposits: retry ${f.kind} ${f.memo} -> ${s}`);
    }
  }

  const expired = expireIntents(now);
  if (expired) log.info(`deposits: ${expired} intent(s) expired`);

  if (env().CHAIN_MODE === "stub" || !open.length) return acted;
  const account = depositAccount();
  const windowStart = Math.min(...open.map((i) => Date.parse(i.createdAt))) - LOOKBACK_MS;
  const sinceMs = Math.max(windowStart, (highWater.get(account) ?? 0) - LOOKBACK_MS);
  let transfers: Awaited<ReturnType<typeof accountTransfers>>;
  try {
    transfers = await accountTransfers(account, { sinceMs });
  } catch (e) {
    log.fail(`deposits: mirror read failed: ${e instanceof Error ? e.message : String(e)}`);
    return acted;
  }
  if (transfers.length) highWater.set(account, Math.max(highWater.get(account) ?? 0, ...transfers.map((t) => consensusMs(t.consensusTimestamp))));
  for (const m of matchDeposits(open, transfers)) {
    const i = open.find((o) => o.id === m.intentId)!;
    const state = await settleIntent(m.intentId, m, now);
    acted++;
    if (state === "funded") log.ok(`deposits: ${i.kind} ${i.memo} funded (${m.received} tinybar from ${m.payer})`);
    else if (state === "failed") log.fail(`deposits: ${i.kind} ${i.memo} handler failed, will retry`);
    else log.info(`deposits: ${i.kind} ${i.memo} ${state} (${m.received}/${i.amountTinybar})`);
  }
  return acted;
}
