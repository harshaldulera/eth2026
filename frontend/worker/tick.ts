import { agentsTick } from "./agents";
import { auditTick } from "./audit";
import { depositsTick } from "./deposits";
import { settleTick } from "./settle";

/** One worker pass: settle ended sieges, advance every active agent run by one siege, then drain the HCS audit outbox. */
export async function tick(): Promise<{ settled: number; runs: number; audited: number }> {
  // ─── Onboarding passes (plans/siege-onboarding-plan.md) register here, before settle: ───
  await depositsTick(); // foundation (worker/deposits.ts — fund vaults/units whose deposit landed)
  // part 2a: guardTick (worker/guard.ts) runs only on its own 1 s loop in worker/index.ts, not in tick().
  const settled = await settleTick();
  const runs = await agentsTick();
  // Sieges the agents just finished settle in the same pass.
  const after = await settleTick();
  const audit = await auditTick();
  return { settled: settled + after, runs, audited: audit.submitted.length };
}
