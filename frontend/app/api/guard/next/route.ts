import { castleRow } from "@/lib/castles";
import { readLeaseId, touchLease } from "@/lib/guard/lease";
import { onConnect } from "@/lib/guard/lifecycle";
import { claimNext, toPayload } from "@/lib/guard/turns";
import { TERMINAL_STATES } from "@/lib/vault";
import { atRequestTime, err, json, NO_STORE } from "../../_lib/http";
import { guardCastle } from "../_lib/auth";

/**
 * GET /api/guard/next (Bearer gk_…, x-siege-lease: <id>, x-siege-sdk: <version>) — the harness's
 * long poll and heartbeat (plan §2A). Blocks up to 25 s (`?waitMs=` 0–25000 shortens it) until a turn
 * is pending for this castle, then claims it for this lease.
 * → 200 {turnId, kind: "siege"|"selfcheck"|"smoke", siegeId, turn, messages: [{role, content}]}
 *     (send siegeId / turn back to our proxy as x-siege-id / x-siege-turn on every model call)
 * | 204 nothing to do, poll again
 * | 400 lease_required | 401 guard_key_invalid | 409 lease_lost (a newer harness took over) | 409 not_sdk | 410 vault_closed
 * The first poll moves created → connected and queues the self-check; a poll on a dormant (or funded)
 * vault moves it to guarding. A new lease id takes over and re-runs the self-check and smoke op.
 */

const MAX_WAIT_MS = 25_000;
const POLL_MS = 300;
const TOUCH_MS = 10_000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });

const lost = () => err(409, "lease_lost", { message: "Another copy of this guard took over. This one should stop." });

export async function GET(req: Request) {
  await atRequestTime();
  const g = guardCastle(req);
  if (!g.ok) return g.res;
  const castleId = g.row.id;
  const leaseId = readLeaseId(req.headers.get("x-siege-lease"));
  if (!leaseId) return err(400, "lease_required", { message: "Send x-siege-lease: <a random id per harness process>." });

  const lease = touchLease(castleId, leaseId, { sdk: req.headers.get("x-siege-sdk") });
  if (!lease.ok) return lease.reason === "lease_lost" ? lost() : err(401, "guard_key_invalid");
  await onConnect(castleId, lease);

  const wait = Number(new URL(req.url).searchParams.get("waitMs"));
  const deadline = Date.now() + (Number.isFinite(wait) && wait >= 0 ? Math.min(wait, MAX_WAIT_MS) : MAX_WAIT_MS);
  let touched = Date.now();
  for (;;) {
    const row = castleRow(castleId);
    if (!row || TERMINAL_STATES.has(row.vaultState)) return err(410, "vault_closed", { vaultState: row?.vaultState ?? null });
    if (row.leaseId !== leaseId) return lost();
    const turn = claimNext(castleId, leaseId);
    if (turn) return json(toPayload(turn));
    if (Date.now() - touched >= TOUCH_MS) {
      const t = touchLease(castleId, leaseId, { force: true });
      if (!t.ok) return lost();
      touched = Date.now();
    }
    if (req.signal.aborted || Date.now() >= deadline) break;
    await sleep(Math.min(POLL_MS, Math.max(0, deadline - Date.now())), req.signal);
  }
  return new Response(null, { status: 204, headers: NO_STORE });
}
