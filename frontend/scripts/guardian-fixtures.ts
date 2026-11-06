/**
 * Guardian model check against a REAL model (plan B1):  npm run guardian:fixtures [model…]
 *
 * For each model: WOODEN_BREAK must open the wooden guardian, and every MUST_NOT_BREAK message must
 * hold against every stone/iron guardian. Uses an in-memory DB (proxy records only) and the active
 * INFERENCE_PROVIDER from .env.local (0g: ZG_API_KEY, claude: ANTHROPIC_API_KEY). Exit 0 = PASS.
 */
import "@/lib/config/load-env";
process.env.DATABASE_URL = ":memory:";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { FIXTURE_CASTLES, loadOrders } from "@/lib/fixtures/castles";
import { MUST_NOT_BREAK, WOODEN_BREAK } from "@/lib/fixtures/raids";
import { zgConfig } from "@/lib/proxy";
import { respondAs } from "@/lib/guardian/zerog";
import type { SiegeMessage } from "@/lib/types";

async function play(c: (typeof FIXTURE_CASTLES)[number], texts: readonly string[], model: string, log: boolean) {
  const g = { tier: c.tier, personality: c.personality, guardianName: c.guardianName, orders: loadOrders(c.tier) };
  const history: SiegeMessage[] = [];
  let opened = false;
  for (const text of texts) {
    const turn = history.filter((m) => m.role === "raider").length + 1;
    history.push({ role: "raider", text, turn, at: "" });
    const t0 = Date.now();
    const d = await respondAs(c.id, g, history, { siegeId: `fixture-${c.id}`, turn }, { model });
    if (log) console.log(`    t${turn} ${d.move.padEnd(4)} ${String(Date.now() - t0).padStart(5)}ms  ${d.requestId}  "${d.reply.slice(0, 60)}"`);
    history.push({ role: "guardian", text: d.reply, turn, at: "", move: d.move, requestId: d.requestId });
    if (d.move === "open") {
      opened = true;
      break;
    }
  }
  return opened;
}

async function run(model: string) {
  console.log(`\n━━━ ${zgConfig.provider} · ${model} ━━━`);
  let pass = true;
  const wooden = FIXTURE_CASTLES.find((c) => c.tier === "wooden")!;
  console.log(`  ${wooden.guardianName} (wooden) must open:`);
  const opened = await play(wooden, WOODEN_BREAK, model, true);
  console.log(`  → ${opened ? "opened ✅" : "held ❌"}`);
  pass &&= opened;

  for (const c of FIXTURE_CASTLES.filter((x) => x.tier !== "wooden")) {
    let held = 0;
    for (const text of MUST_NOT_BREAK) if (!(await play(c, [text], model, false))) held++;
    const ok = held === MUST_NOT_BREAK.length;
    console.log(`  ${c.guardianName} (${c.tier}) holds ${held}/${MUST_NOT_BREAK.length} ${ok ? "✅" : "❌"}`);
    pass &&= ok;
  }
  console.log(`  RESULT: ${pass ? "PASS ✅" : "FAIL ❌"}`);
  return pass;
}

async function main() {
  if (zgConfig.mock) {
    const need = zgConfig.provider === "claude" ? "ANTHROPIC_API_KEY" : "ZG_API_KEY";
    console.error(`${need} is not set (or ZG_MOCK=1): this script checks real models (INFERENCE_PROVIDER=${zgConfig.provider}). Add the key to .env.local.`);
    process.exit(2);
  }
  freshFixtureDb();
  const models = process.argv.slice(2);
  let all = true;
  const fallback = zgConfig.provider === "claude" ? zgConfig.anthropicModel : zgConfig.defaultModel;
  for (const m of models.length ? models : [fallback]) all = (await run(m)) && all;
  process.exit(all ? 0 : 1);
}
main();
