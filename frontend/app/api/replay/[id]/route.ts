import { getCastle } from "@/lib/castles";
import { auditTrail } from "@/lib/chain";
import { eventsSince } from "@/lib/events/bus";
import { record } from "@/lib/proxy";
import { buildReplay } from "@/lib/replay/build";
import { getSiege } from "@/lib/siege";
import type { ReplayRequest, ReplayResponse, ReplayWithVerify } from "@/lib/api/client";
import type { Castle, Siege, ToolCall } from "@/lib/types";
import { atRequestTime, err, json } from "../../_lib/http";

/**
 * GET /api/replay/[id] (plan §2.9): everything a replay needs in one round trip.
 *
 *   { siege, castle, events, proof: { transcriptHash, receipt, attempt, release, requests, toolCall, hcs } }
 *
 * `events` is the siege's whole feed (eventsSince(0, { siegeId })), which is all `toBeats` needs.
 * `proof.requests` lists each guard reply's 0G request id with what the vault-scoped proxy recorded
 * for it (hashes and tool names only; nothing is recorded for stub replies). `toolCall` is the call
 * to the castle's protected tool that broke the vault, with its arguments, when there was one.
 *
 * `verify` is lib/replay's ReplayData: the same siege with every check recomputed (the transcript from
 * Swarm against its stored hash, the hash on the castle's HCS topic, each raider message against its
 * HCS hash, each guardian reply's inference record, the verifier's verdict and the payout tx), null
 * if it could not be built. Read-only, with one exception: when Swarm does not answer for an op's
 * transcript, a flag asks the worker to re-upload it (lib/swarm requestReupload, written once).
 * Network reads: the transcript from Swarm (SWARM_MODE=live) and the mirror-node check on testnet
 * topics. `?verify=0` skips them (`verify: null`).
 */

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function toolCallsOf(v: unknown): ToolCall[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((c): c is ToolCall => !!c && typeof c === "object" && typeof (c as ToolCall).name === "string")
    .map((c) => ({ name: c.name, args: c.args && typeof c.args === "object" ? (c.args as Record<string, unknown>) : {} }));
}

function namesOf(raw: string | null | undefined): string[] | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
  } catch {
    return undefined;
  }
}

function buildPixelReplay(siege: Siege, castle: Castle): ReplayResponse {
  const events = eventsSince(0, { siegeId: siege.id, limit: 1000 });

  // One request per guard reply, by turn (the latest decision event of a turn wins).
  const byTurn = new Map<number, { requestId: string; calls: ToolCall[] }>();
  for (const e of events) {
    if (e.type !== "decision" || !e.turn) continue;
    const requestId = str(e.payload.requestId) ?? e.requestId;
    if (!requestId) continue;
    byTurn.set(e.turn, { requestId, calls: toolCallsOf(e.payload.toolCalls) });
  }
  for (const m of siege.messages) {
    if (m.role === "guardian" && m.requestId && !byTurn.has(m.turn)) byTurn.set(m.turn, { requestId: m.requestId, calls: [] });
  }

  const requests: ReplayRequest[] = [];
  let toolCall: ReplayResponse["proof"]["toolCall"] = null;
  for (const turn of [...byTurn.keys()].sort((a, b) => a - b)) {
    const { requestId, calls } = byTurn.get(turn)!;
    const rec = record(requestId);
    const out: ReplayRequest = { turn, requestId };
    if (rec) {
      out.protectedToolCalled = rec.protectedToolCalled;
      out.toolCalls = namesOf(rec.toolCalls);
      // Never send rec.promptHash or rec.responseHash to the browser. promptHash is an unsalted
      // sha256 of the guard's whole system prompt, and that prompt is public template text plus the
      // guard's secret orders. Anyone holding the hash can guess orders offline and check each guess
      // against it, with no rate limit and no pay-per-op, which is exactly what operators pay to try.
      // responseHash is the same kind of oracle for the model's raw reply. The verifier checks both
      // server-side (lib/siege/verifier.ts); the replay only needs to know a proxy record exists.
      out.proxied = true;
      out.model = rec.model;
      out.mock = rec.mock;
    } else if (calls.length) {
      out.toolCalls = calls.map((c) => c.name);
    }
    requests.push(out);
    const fired = calls.find((c) => c.name === castle.protectedTool);
    if (fired && !toolCall) toolCall = { ...fired, turn };
  }

  const trail = auditTrail(castle.id, 500);
  return {
    siege,
    castle,
    events,
    proof: {
      transcriptHash: siege.transcriptHash ?? null,
      receipt: siege.receipt ?? null,
      attempt: siege.attempt ?? null,
      release: siege.release ?? null,
      requests,
      toolCall,
      hcs: { topicId: trail.topicId, topicUrl: trail.topicUrl, messages: trail.messages.filter((m) => m.siegeId === siege.id) },
    },
  };
}

/** GET /api/replay/[id] — the op, its castle, its event feed, its proof and the recomputed checks. Public. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  await atRequestTime();
  const { id } = await ctx.params;
  const siege = getSiege(id);
  if (!siege) return err(404, "siege_not_found");
  const castle = getCastle(siege.castleId);
  if (!castle) return err(404, "castle_not_found");
  // ?verify=0: the scene only (pollers such as the wall); the checks read Swarm and the mirror node.
  const skip = new URL(req.url).searchParams.get("verify") === "0";
  const verify = skip
    ? null
    : await buildReplay(id).catch((e: unknown) => {
        console.error("[replay] verify failed", id, e);
        return null;
      });
  const body: ReplayWithVerify = { ...buildPixelReplay(siege, castle), verify };
  return json(body);
}
