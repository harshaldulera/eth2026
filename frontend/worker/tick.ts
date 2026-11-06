import { agentsTick } from "./agents";
import { auditTick } from "./audit";
import { settleTick } from "./settle";

/** One worker pass: settle ended sieges, advance every active agent run by one siege, then drain the HCS audit outbox. */
export async function tick(): Promise<{ settled: number; runs: number; audited: number }> {
  const settled = await settleTick();
  const runs = await agentsTick();
  // Sieges the agents just finished settle in the same pass.
  const after = await settleTick();
  const audit = await auditTick();
  return { settled: settled + after, runs, audited: audit.submitted.length };
}
