import { agentsTick } from "./agents";
import { settleTick } from "./settle";

/** One worker pass: settle ended sieges, then advance every active agent run by one siege. */
export async function tick(): Promise<{ settled: number; runs: number }> {
  const settled = await settleTick();
  const runs = await agentsTick();
  // Sieges the agents just finished settle in the same pass.
  const after = await settleTick();
  return { settled: settled + after, runs };
}
