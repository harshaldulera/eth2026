import * as proxy from "@/lib/proxy";
import type { ChatRequest, ToolDef } from "@/lib/proxy";
import { touchLease } from "./lease";
import { onReply } from "./lifecycle";
import { answerTurn, claimNext, type GuardReply, type GuardTurnPayload, toPayload } from "./turns";

/**
 * Tests and offline scripts: an in-process stand-in for an siege-guard harness. It keeps its lease
 * alive, claims turns, thinks through our proxy (proxy.chat with the castle's vault key, tagged with
 * the turn's siege id and turn, exactly what the SDK sends as x-siege-id / x-siege-turn) and answers.
 * Never used by the app itself.
 */
export type FakeHarness = { stop(): Promise<void>; readonly answered: number };

export function startFakeHarness(opts: {
  castleId: string;
  protectedTool: string;
  system: string;
  tools: ToolDef[];
  leaseId?: string;
  pollMs?: number;
  model?: string;
  /** Override the reply (default: the model's text and the tools it called). */
  decide?: (turn: GuardTurnPayload, model: { content: string; toolCalls: string[] }) => GuardReply;
  /** Skip the proxy call (a harness that answers without thinking). */
  skipModel?: boolean;
}): FakeHarness {
  const leaseId = opts.leaseId ?? "lease-fake-harness";
  const pollMs = opts.pollMs ?? 10;
  let stopped = false;
  let answered = 0;
  const loop = (async () => {
    while (!stopped) {
      const lease = touchLease(opts.castleId, leaseId, { force: true });
      if (!lease.ok) return;
      const row = claimNext(opts.castleId, leaseId);
      if (row) {
        const turn = toPayload(row);
        let model = { content: "", toolCalls: [] as string[] };
        if (!opts.skipModel) {
          const req: ChatRequest = { model: opts.model ?? "test-model", messages: [{ role: "system", content: opts.system }, ...turn.messages], tools: opts.tools };
          const r = await proxy.chat(proxy.issueKey(opts.castleId, opts.protectedTool), req, { siegeId: turn.siegeId ?? undefined, turn: turn.turn ?? undefined });
          if (r.ok) model = { content: r.result.message.content ?? "", toolCalls: (r.result.message.tool_calls ?? []).map((c) => c.function.name) };
        }
        const reply = opts.decide?.(turn, model) ?? { reply: model.content || "…", toolCalls: model.toolCalls.map((name) => ({ name })) };
        if (answerTurn(turn.turnId, leaseId, reply) === "ok") {
          answered++;
          await onReply(row, reply);
        }
        continue;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  })();
  return {
    async stop() {
      stopped = true;
      await loop;
    },
    get answered() {
      return answered;
    },
  };
}
