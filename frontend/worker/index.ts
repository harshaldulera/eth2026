/**
 * The Siege worker:  npm run worker   (tsx worker/index.ts)
 *
 * Independent loops, every second: settlement (chain.recordAttempt / verifier + release), the
 * raider-agent runner, the HCS audit drainer (the only process that submits audit messages, one
 * topic message at a time in order: lib/chain/outbox.ts), with ARKIV_MODE=live the Arkiv
 * publisher (lib/arkiv/outbox.ts), and with SWARM_MODE=live the Swarm retry and keep-alive loop
 * (lib/swarm/live.ts). The only process that holds VERIFIER_KEY. Talks to the Next server at APP_URL
 * for agent sieges (the real x402 round-trip). `tick()` runs one pass of both, for scripts.
 */
import "@/lib/config/load-env";
import { env } from "@/lib/config/env";
import { auditBacklog, chainStateProblems } from "@/lib/chain";
import { db } from "@/lib/db";
import { guardianMode } from "@/lib/transport";
import { isArkivLive } from "@/lib/arkiv/config";
import { swarmConfig, swarmStatus } from "@/lib/swarm";
import { agentsTick } from "./agents";
import { arkivTick } from "./arkiv";
import { auditTick } from "./audit";
import { depositsTick } from "./deposits";
import { guardTick } from "./guard";
import { log } from "./log";
import { settleTick } from "./settle";
import { swarmTick } from "./swarm";

export { tick } from "./tick";
export { setFetch } from "./fetch";

const INTERVAL_MS = 1000;

function loop(name: string, fn: () => Promise<unknown>, stopped: () => boolean): Promise<void> {
  return (async () => {
    while (!stopped()) {
      try {
        await fn();
      } catch (e) {
        log.fail(`${name} loop: ${e instanceof Error ? e.message : String(e)}`);
      }
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    }
  })();
}

export function main(): void {
  const e = env();
  // Never settle real money against a stub-seeded DB or vaults on an old deployment.
  const problems = chainStateProblems();
  if (problems.length) {
    log.fail(`CHAIN_MODE=${e.CHAIN_MODE} but ${e.DATABASE_URL} holds state from another chain:`);
    for (const p of problems) log.fail(`  ${p}`);
    log.fail("Run `npm run seed` (it recreates vaults/topics/agents for this env), then start the worker again.");
    process.exit(1);
  }
  let stopping = false;
  // The verifier accepts stub ("0g-stub-…") replies only in stub mode and mock 0G replies only with
  // ZG_ALLOW_MOCK_VERIFY=1, so say which guardian this process verifies against.
  const gm = guardianMode();
  const mock = gm === "0g" && (process.env.ZG_MOCK === "1" || !process.env.ZG_API_KEY);
  log.info(`worker up — CHAIN_MODE=${e.CHAIN_MODE}, GUARDIAN_MODE=${gm}${mock ? " (offline 0G mock)" : ""}, db ${e.DATABASE_URL}, api ${e.APP_URL}`);
  const backlog = auditBacklog(db());
  if (backlog.length)
    log.info(`hcs outbox: ${backlog.reduce((n, b) => n + b.pending, 0)} queued audit message(s) on ${backlog.length} topic(s), submitting in order`);
  const loops = [
    loop("settle", settleTick, () => stopping),
    loop("agents", agentsTick, () => stopping),
    loop("audit", auditTick, () => stopping),
  ];
  // Lane C: publish the board to Arkiv from this process (one wallet, one nonce sequence).
  if (isArkivLive()) {
    log.info("arkiv: ARKIV_MODE=live, publishing vaults, ops and profiles");
    loops.push(loop("arkiv", arkivTick, () => stopping));
  }
  // ─── Onboarding loops (plans/siege-onboarding-plan.md) register here, one push each: ───
  loops.push(loop("deposits", depositsTick, () => stopping)); // foundation (worker/deposits.ts)
  loops.push(loop("guard", guardTick, () => stopping)); // part 2a (worker/guard.ts — expire turns, dormant, prompt drift)
  // Lane C: retry and keep alive the sealed transcripts on Swarm.
  const sc = swarmConfig();
  if (sc.mode === "live") {
    log.info(`swarm: ${swarmStatus()}`);
    loops.push(loop("swarm", swarmTick, () => stopping));
  } else if (sc.refused) log.fail(`swarm: ${swarmStatus()}`);
  const done = Promise.all(loops);
  const shutdown = (sig: string) => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info(`${sig}: finishing the current pass…`);
    void done.then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

if (/worker[\\/]index\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) main();
