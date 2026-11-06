/**
 * Seed the arena:  npm run seed            (npm run seed -- --rearm wooden | <castle id> | <name> | broken | all)
 *                                           (npm run seed -- --new-topics: a fresh HCS topic for every castle)
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
 * deadline and the fixture streak, back to vault state "guarding" — e.g. re-run the wooden payout demo
 * after a rehearsal. Other castles are left alone.
 *
 * Vault lifecycle (lib/vault): every hosted fixture castle walks created -> verified ("hosted guardian
 * ready") -> funded (after createVault with protectedTool "unlock_vault") -> guarding ("open for sieges"),
 * each transition audited on the castle's HCS topic as "vault.state". Castles already guarding are left
 * alone. The sixth castle, Refund Desk, is the bring-your-agent story: an SDK guardian protecting
 * "issue_refund". It seeds to "created" only — Lane B's SDK (or, in stub mode, the dev endpoint
 * POST /api/castles/[id]/vault-state) walks it to guarding. Re-arming it closes any open vault and
 * puts it back to "created".
 *
 * --new-topics: give every castle a NEW HCS audit topic, even if it has one (the old topic stays on
 * chain, unchanged; rows already queued for it still drain to it). Use it before the freeze so the
 * submitted topics hold only messages written by the ordered audit outbox. Combines with --rearm.
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
import { VAULT_OPEN_STATES } from "@/lib/chain/settle";
import { BUSINESS_CASTLES, FIXTURE_CASTLES, SDK_FIXTURE_CASTLE, SDK_ORDERS_PLACEHOLDER, fixtureCastleRow, loadOrders, type FixtureCastle } from "@/lib/fixtures/castles";
import { createAgent, listAgents, setAgentStatus } from "@/lib/agents/accounts";
import { HOSTED_PROTECTED_TOOL, type RaiderAgent, type TransportKind, type VaultState } from "@/lib/types";
import { closeCastle, TERMINAL_STATES, transitionVault } from "@/lib/vault";
import { provisionGuardKeys } from "@/lib/guard/keys";

const VAULT_DAYS = 3;
const DEMO_AGENT = "Night Sapper";

/**
 * The sixth castle: an external agent guarded through the @siege/guard SDK (Lane B), protecting
 * "issue_refund". Single source of truth is lib/fixtures (SDK_FIXTURE_CASTLE), shared with the
 * transport/siege tests, so the seeded row and the test row cannot drift.
 */
export const REFUND_DESK = SDK_FIXTURE_CASTLE as FixtureCastle & { transport: TransportKind; protectedTool: string };
/** An SDK guardian's orders live in the castellan's own harness; we never hold them. */
const SDK_ORDERS = SDK_ORDERS_PLACEHOLDER;

/** Everything seed creates: the five game castles, the Refund Desk, and the business agents. */
export const SEED_CASTLES: readonly FixtureCastle[] = [...FIXTURE_CASTLES, REFUND_DESK, ...BUSINESS_CASTLES];
const isSdk = (f: FixtureCastle) => f.id === REFUND_DESK.id;

const link = (url: string, id: string) => (isStubRef(id) ? id : `${id}  ${url}`);

export type SeedSummary = {
  castles: {
    id: string;
    name: string;
    tier: string;
    fee: number;
    pot: number;
    streak: number;
    vaultId: number | null;
    topicId: string | null;
    status: string;
    vaultState: VaultState;
    transport: TransportKind;
    protectedTool: string;
  }[];
  agent: RaiderAgent | null;
  /** The Refund Desk's gk_ (SDK harness credential), minted if missing. `npm run seed` prints it. */
  guardKey?: string;
};

/** Does `--rearm <target>` select this castle? */
function rearmMatches(target: string, row: { id: string; name: string; tier: string; status: string }): boolean {
  const t = target.trim().toLowerCase();
  return t === "all" || (t === "broken" && row.status !== "open") || t === row.id.toLowerCase() || t === row.name.toLowerCase() || t === row.tier;
}

export async function seed(opts: { quiet?: boolean; rearm?: string; newTopics?: boolean } = {}): Promise<SeedSummary> {
  const say = (s: string) => !opts.quiet && console.log(s);
  const e = env();
  const testnet = e.CHAIN_MODE === "testnet";
  const owner = testnet ? e.HEDERA_OPERATOR_ID : undefined;
  if (testnet && !owner) throw new Error("CHAIN_MODE=testnet needs HEDERA_OPERATOR_ID (the castellan of the seeded vaults).");
  if (testnet && !e.VAULT_ADDRESS) throw new Error("CHAIN_MODE=testnet needs VAULT_ADDRESS: run `npm run deploy:vault` first.");
  const tag = vaultTag();
  say(`Seeding (CHAIN_MODE=${e.CHAIN_MODE}, db ${e.DATABASE_URL}, vaults on ${tag})`);
  const C = schema.castles;

  /** One audited vault transition (awaited: its vault.state row is queued in the HCS audit outbox, and the worker submits it). */
  async function step(id: string, to: VaultState, reason: string, force = false): Promise<boolean> {
    const r = await transitionVault(id, to, reason, { force, awaitSideEffects: true });
    if (r.ok) say(`    → ${r.change.from} → ${to}: ${reason}`);
    else say(`    ✗ vault state → ${to}: ${r.reason}`);
    return r.ok;
  }

  async function newVault(row: typeof C.$inferSelect, f: FixtureCastle, why: string, reset: boolean): Promise<{ vaultId: number; pot: number } | null> {
    const pot = reset ? f.potTinybar : row.potTinybar;
    const r = await chain.createVault({
      castleId: row.id,
      pot: String(pot),
      fee: String(row.feeTinybar),
      durationSec: VAULT_DAYS * 24 * 60 * 60,
      castellan: row.owner,
      protectedTool: row.protectedTool || HOSTED_PROTECTED_TOOL,
    });
    if (!r.ok) {
      say(`    ✗ createVault (${why}): ${r.reason}`);
      return null;
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
    return { vaultId: r.vaultId, pot };
  }

  let refundGuardKey: string | undefined;
  for (const f of SEED_CASTLES) {
    const sdk = isSdk(f);
    const identity = sdk
      ? { transport: REFUND_DESK.transport, protectedTool: REFUND_DESK.protectedTool, orders: SDK_ORDERS }
      : { transport: "hosted" as const, protectedTool: f.protectedTool ?? HOSTED_PROTECTED_TOOL, orders: loadOrders(f.ordersFile ?? f.tier) };
    // By id first (tests may have inserted the SDK fixture under another display name), then by name.
    let row = db().select().from(C).where(eq(C.id, f.id)).get() ?? db().select().from(C).where(eq(C.name, f.name)).get();
    if (!row) {
      db()
        .insert(C)
        .values({ ...fixtureCastleRow(f, owner ? { owner } : {}), ...identity, vaultState: "created", vaultStateReason: null })
        .run();
      row = db().select().from(C).where(eq(C.name, f.name)).get()!;
      say(`  + ${f.name}${sdk ? " (SDK guardian, protects issue_refund)" : f.ordersFile ? ` (business agent, protects ${f.protectedTool})` : ""}`);
    } else {
      db()
        .update(C)
        .set({ name: f.name, guardianName: f.guardianName, personality: f.personality, tier: f.tier, portraitUrl: f.portraitUrl ?? null, ...identity })
        .where(eq(C.id, row.id))
        .run();
      row = db().select().from(C).where(eq(C.id, row.id)).get()!;
      say(`  = ${f.name} (kept pot/streak/status, vault ${row.vaultState})`);
    }

    // A stub castellan cannot receive real HBAR.
    if (testnet && owner && isStubRef(row.owner)) {
      db().update(C).set({ owner }).where(eq(C.id, row.id)).run();
      row = { ...row, owner };
      say(`    ↻ castellan ${owner} (was a stub account)`);
    }

    // The audit topic first, so every vault.state transition below lands on it.
    if (!row.topicId || (testnet && isStubRef(row.topicId)) || opts.newTopics) {
      const was = row.topicId;
      const r = await chain.createTopic(row.id);
      if (r.ok) {
        db().update(C).set({ topicId: r.topicId }).where(eq(C.id, row.id)).run();
        row = { ...row, topicId: r.topicId };
        say(`    ✓ HCS topic ${link(topicUrl(r.topicId), r.topicId)}${was && was !== r.topicId ? ` (new; was ${was})` : ""}`);
      } else say(`    ✗ createTopic: ${r.reason}`);
    }

    // Legacy stub rows (before vault_address existed) belong to the stub chain.
    const recorded = row.vaultAddress ?? (row.vaultId != null && !testnet ? "stub" : null);
    const rearm = Boolean(opts.rearm && rearmMatches(opts.rearm, row));
    // Vault id belongs to another contract (stub DB flipped to testnet, or a redeploy): start fresh.
    const foreign = row.vaultId != null && recorded !== tag;

    if (sdk) {
      // The harness credentials: gk_/vk_ minted once, kept on re-seeds. In stub mode the Refund Desk also gets a
      // stand-in 0G key so /api/guard/hello answers; on testnet it stays null until the owner connects 0G.
      const keys = provisionGuardKeys(row.id);
      if (keys) refundGuardKey = keys.guardKey;
      if (!testnet && !row.zgApiKey) {
        db().update(C).set({ zgApiKey: "sk-stub-refund-desk" }).where(eq(C.id, row.id)).run();
        row = { ...row, zgApiKey: "sk-stub-refund-desk" };
      }
      // The SDK castle is never funded by seed: the harness has to connect and pass its smoke siege first.
      if (rearm && row.vaultState !== "created") {
        if (row.vaultId != null && !foreign && row.status === "open" && VAULT_OPEN_STATES.has(row.vaultState)) {
          const c = await closeCastle(row.id, "owner_closed", { awaitSideEffects: true });
          say(c.ok ? `    ✓ closed vault #${row.vaultId} (${formatHbar(BigInt(c.refunded))} back to the castellan)` : `    ✗ closeVault: ${c.reason}`);
        }
        db().update(C).set({ potTinybar: f.potTinybar, streak: f.streak }).where(eq(C.id, row.id)).run();
        await step(row.id, "created", "re-armed: waiting for the external harness to connect", true);
      } else if (foreign && row.vaultState !== "created") {
        await step(row.id, "created", `vault #${row.vaultId} was on ${recorded ?? "an unknown contract"}: waiting for the harness again`, true);
      }
      continue;
    }

    if (!rearm && !foreign && TERMINAL_STATES.has(row.vaultState)) {
      say(`    · vault ${row.vaultState} (npm run seed -- --rearm ${f.tier} reopens it)`);
      if (row.vaultId != null && row.vaultAddress == null) db().update(C).set({ vaultAddress: tag }).where(eq(C.id, row.id)).run();
      continue;
    }
    let state: VaultState = row.vaultState;
    if (state === "created" && (await step(row.id, "verified", "hosted guardian ready"))) state = "verified";

    if (rearm || foreign || row.vaultId == null) {
      const why = rearm ? "re-armed" : foreign ? `vault #${row.vaultId} was on ${recorded ?? "an unknown contract"}` : "new";
      const v = await newVault(row, f, why, rearm || foreign);
      if (v) {
        const reason = `vault #${v.vaultId} ${rearm ? "re-armed" : "funded"} with ${formatHbar(BigInt(v.pot))}`;
        // A guarding/broken castle getting a new vault re-enters the lifecycle at funded.
        if (await step(row.id, "funded", reason, state !== "verified")) state = "funded";
      }
    } else {
      if (row.vaultAddress == null) db().update(C).set({ vaultAddress: tag }).where(eq(C.id, row.id)).run();
      if (state === "verified" && (await step(row.id, "funded", `vault #${row.vaultId} funded with ${formatHbar(BigInt(row.potTinybar))}`))) state = "funded";
    }
    if (state === "funded") await step(row.id, "guarding", "open for sieges");
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
      vaultState: c.vaultState,
      transport: c.transport,
      protectedTool: c.protectedTool,
    })),
    agent,
    guardKey: refundGuardKey,
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
        vault_state: c.vaultState,
        transport: c.transport,
        tool: c.protectedTool,
      })),
    );
    if (testnet && e.VAULT_ADDRESS) console.log(`SiegeVault ${contractUrl(e.VAULT_ADDRESS)}`);
    if (agent) console.log(`Demo raider agent: ${agent.name} ${agent.accountId} (${agent.id})`);
    if (refundGuardKey) {
      console.log(`SIEGE_GUARD_KEY=${refundGuardKey}  (node examples/guard-refund-bot/index.mjs)`);
      if (testnet) console.log("  Refund Desk 0G key is empty on testnet: connect one on the plug-in page before the bot can start.");
    }
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
  seed({ rearm, newTopics: process.argv.includes("--new-topics") }).then(
    () => process.exit(0),
    (err) => {
      console.error("✗ seed failed:", err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
