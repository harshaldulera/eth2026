/**
 * Seed the arena:  npm run seed            (npm run seed -- --rearm wooden | <castle id> | <name> | broken | all)
 *
 * Idempotent: upserts the five FIXTURE_CASTLES by name (refreshes guardian/orders, never resets money
 * state), creates the on-chain vault and the HCS audit topic for each castle that lacks one (testnet:
 * real SiegeVault.createVault + TopicCreateTransaction with HashScan links; stub: the stub chain),
 * and creates the demo raider agent "Night Sapper" if missing.
 *
 * Chain-state check: every castle records which contract its vaultId lives in (castles.vault_address:
 * VAULT_ADDRESS on testnet, "stub" in stub mode). When that does not match the current env — a DB
 * seeded in stub mode and then flipped to CHAIN_MODE=testnet, or a redeployed SiegeVault — the vault
 * is recreated (fixture pot, status open). On testnet, stub HCS topics, stub castellans and a stub
 * Night Sapper are replaced too (the stub agent is renamed "… (stub)" and stopped).
 *
 * --rearm <target>: give the matching castle(s) a NEW vault with the fixture pot, status open, a fresh
 * deadline and the fixture streak — e.g. re-run the wooden payout demo after a rehearsal. Other
 * castles are left alone.
 *
 * NOTE: streak / siegeCount values come from the fixtures and are COSMETIC demo history (the Iron
 * Warden's 212 is there for the pitch). The on-chain vault streak starts at 0, so DB and contract
 * streaks differ by that offset.
 */
import "@/lib/config/load-env";
import { eq } from "drizzle-orm";
import { env } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { chain, contractUrl, formatHbar, topicUrl, txUrl, isStubRef, vaultTag } from "@/lib/chain";
import { FIXTURE_CASTLES, fixtureCastleRow, loadOrders, type FixtureCastle } from "@/lib/fixtures/castles";
import { createAgent, listAgents, setAgentStatus } from "@/lib/agents/accounts";
import type { RaiderAgent } from "@/lib/types";

const VAULT_DAYS = 3;
const DEMO_AGENT = "Night Sapper";

const link = (url: string, id: string) => (isStubRef(id) ? id : `${id}  ${url}`);

export type SeedSummary = {
  castles: { id: string; name: string; tier: string; fee: number; pot: number; streak: number; vaultId: number | null; topicId: string | null; status: string }[];
  agent: RaiderAgent | null;
};

/** Does `--rearm <target>` select this castle? */
function rearmMatches(target: string, row: { id: string; name: string; tier: string; status: string }): boolean {
  const t = target.trim().toLowerCase();
  return t === "all" || (t === "broken" && row.status !== "open") || t === row.id.toLowerCase() || t === row.name.toLowerCase() || t === row.tier;
}

export async function seed(opts: { quiet?: boolean; rearm?: string } = {}): Promise<SeedSummary> {
  const say = (s: string) => !opts.quiet && console.log(s);
  const e = env();
  const testnet = e.CHAIN_MODE === "testnet";
  const owner = testnet ? e.HEDERA_OPERATOR_ID : undefined;
  if (testnet && !owner) throw new Error("CHAIN_MODE=testnet needs HEDERA_OPERATOR_ID (the castellan of the seeded vaults).");
  if (testnet && !e.VAULT_ADDRESS) throw new Error("CHAIN_MODE=testnet needs VAULT_ADDRESS: run `npm run deploy:vault` first.");
  const tag = vaultTag();
  say(`Seeding (CHAIN_MODE=${e.CHAIN_MODE}, db ${e.DATABASE_URL}, vaults on ${tag})`);
  const C = schema.castles;

  async function newVault(row: typeof C.$inferSelect, f: FixtureCastle, why: string, reset: boolean) {
    const pot = reset ? f.potTinybar : row.potTinybar;
    const r = await chain.createVault({
      castleId: row.id,
      pot: String(pot),
      fee: String(row.feeTinybar),
      durationSec: VAULT_DAYS * 24 * 60 * 60,
      castellan: row.owner,
    });
    if (!r.ok) {
      say(`    ✗ createVault (${why}): ${r.reason}`);
      return;
    }
    // The contract's deadline is now + duration: keep the DB in step.
    db()
      .update(C)
      .set({
        vaultId: r.vaultId,
        vaultAddress: tag,
        createVaultTx: r.tx.txId,
        deadline: Date.now() + VAULT_DAYS * 24 * 60 * 60 * 1000,
        ...(reset ? { potTinybar: pot, status: "open" as const, streak: f.streak } : {}),
      })
      .where(eq(C.id, row.id))
      .run();
    say(`    ✓ vault #${r.vaultId} on ${tag} (${why}; ${formatHbar(BigInt(pot))} pot) tx ${link(txUrl(r.tx.txId), r.tx.txId)}`);
  }

  for (const f of FIXTURE_CASTLES) {
    let row = db().select().from(C).where(eq(C.name, f.name)).get();
    if (!row) {
      db().insert(C).values(fixtureCastleRow(f, owner ? { owner } : {})).run();
      row = db().select().from(C).where(eq(C.name, f.name)).get()!;
      say(`  + ${f.name}`);
    } else {
      db()
        .update(C)
        .set({ guardianName: f.guardianName, personality: f.personality, tier: f.tier, orders: loadOrders(f.tier), portraitUrl: f.portraitUrl ?? null })
        .where(eq(C.id, row.id))
        .run();
      say(`  = ${f.name} (kept pot/streak/status)`);
    }

    // A stub castellan cannot receive real HBAR.
    if (testnet && owner && isStubRef(row.owner)) {
      db().update(C).set({ owner }).where(eq(C.id, row.id)).run();
      row = { ...row, owner };
      say(`    ↻ castellan ${owner} (was a stub account)`);
    }

    // Legacy stub rows (before vault_address existed) belong to the stub chain.
    const recorded = row.vaultAddress ?? (row.vaultId != null && !testnet ? "stub" : null);
    if (opts.rearm && rearmMatches(opts.rearm, row)) {
      await newVault(row, f, "re-armed", true);
    } else if (row.vaultId == null) {
      await newVault(row, f, "new", false);
    } else if (recorded !== tag) {
      // Vault id belongs to another contract (stub DB flipped to testnet, or a redeploy): start fresh.
      await newVault(row, f, `vault #${row.vaultId} was on ${recorded ?? "an unknown contract"}`, true);
    } else if (row.vaultAddress == null) {
      db().update(C).set({ vaultAddress: tag }).where(eq(C.id, row.id)).run();
    }
    if (!row.topicId || (testnet && isStubRef(row.topicId))) {
      const r = await chain.createTopic(row.id);
      if (r.ok) {
        db().update(C).set({ topicId: r.topicId }).where(eq(C.id, row.id)).run();
        say(`    ✓ HCS topic ${link(topicUrl(r.topicId), r.topicId)}`);
      } else say(`    ✗ createTopic: ${r.reason}`);
    }
  }

  let agent = listAgents().find((a) => a.name === DEMO_AGENT) ?? null;
  if (agent && testnet && isStubRef(agent.accountId)) {
    // A stub account cannot pay real x402 fees: retire it and create a real one.
    db().update(schema.raiderAgents).set({ name: `${DEMO_AGENT} (stub)` }).where(eq(schema.raiderAgents.id, agent.id)).run();
    setAgentStatus(agent.id, "stopped");
    say(`  ↻ retired stub agent ${agent.accountId} (renamed "${DEMO_AGENT} (stub)")`);
    agent = null;
  }
  if (!agent) {
    const granite = FIXTURE_CASTLES.find((c) => c.name === "Granite Hold")!;
    try {
      agent = await createAgent({ name: DEMO_AGENT, strategy: "authority", perCastleCap: String(2 * granite.feeTinybar) });
      say(`  + agent ${agent.name} (${agent.accountId}), per-castle cap ${formatHbar(BigInt(agent.perCastleCap))}`);
    } catch (err) {
      say(`  ✗ agent ${DEMO_AGENT}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const castles = db().select().from(C).all();
  const summary: SeedSummary = {
    castles: castles.map((c) => ({
      id: c.id,
      name: c.name,
      tier: c.tier,
      fee: c.feeTinybar,
      pot: c.potTinybar,
      streak: c.streak,
      vaultId: c.vaultId,
      topicId: c.topicId,
      status: c.status,
    })),
    agent,
  };
  if (!opts.quiet) {
    console.log("");
    console.table(
      summary.castles.map((c) => ({
        castle: c.name,
        tier: c.tier,
        fee: formatHbar(BigInt(c.fee)),
        pot: formatHbar(BigInt(c.pot)),
        streak: c.streak,
        vault: c.vaultId ?? "-",
        topic: c.topicId ?? "-",
        status: c.status,
      })),
    );
    if (testnet && e.VAULT_ADDRESS) console.log(`SiegeVault ${contractUrl(e.VAULT_ADDRESS)}`);
    if (agent) console.log(`Demo raider agent: ${agent.name} ${agent.accountId} (${agent.id})`);
  }
  return summary;
}

if (/scripts[\\/]seed\.[cm]?[jt]s$/.test(process.argv[1] ?? "")) {
  const i = process.argv.indexOf("--rearm");
  const rearm = i >= 0 ? process.argv[i + 1] : undefined;
  if (i >= 0 && !rearm) {
    console.error("usage: npm run seed -- --rearm <wooden|stone|iron|castle id|castle name|broken|all>");
    process.exit(1);
  }
  seed({ rearm }).then(
    () => process.exit(0),
    (err) => {
      console.error("✗ seed failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
