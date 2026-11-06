/**
 * Deposit handlers for the publish flow (plan §1). Registered at module load (`registerPublishHandlers`),
 * so every import chain that reaches this file (POST /api/castles, POST /api/castles/[id]/fund, the
 * worker's deposit loop) has them. Both handlers are resumable: they look at what already exists
 * (castle row, topic, vault id, vault state) and only do the missing steps, so a failed intent
 * that the worker retries never creates a second castle, topic or on-chain vault.
 */
import { eq } from "drizzle-orm";
import { castleRow } from "@/lib/castles";
import { chain } from "@/lib/chain";
import { env } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { noteIntent, onDepositConfirmed, setIntentStep, type DepositIntent } from "@/lib/pay/deposits";
import { fundVault, transitionVault } from "@/lib/vault";

const DAY_MS = 86_400_000;

/** The secret the publish form leaves in vault_drafts.form (never returned by any route). */
export type DraftForm = {
  name: string;
  guardName: string;
  blurb: string;
  voice: string;
  orders: string;
  tools: unknown[];
  protectedTool: string;
  zg: { apiKey: string; mgmtKey: string | null; keyId: string | null };
};

const firstTx = (txs: string): string | null => {
  try {
    const v: unknown = JSON.parse(txs);
    return Array.isArray(v) && typeof v[0] === "string" ? v[0] : null;
  } catch {
    return null;
  }
};

async function ensureTopic(castleId: string): Promise<void> {
  if (castleRow(castleId)?.topicId) return;
  const r = await chain.createTopic(castleId);
  if (!r.ok) throw new Error(`create_topic_failed: ${r.reason}`);
  db().update(schema.castles).set({ topicId: r.topicId }).where(eq(schema.castles.id, castleId)).run();
}

/** Setup steps the deposit panel shows as SETTING UP k/3. */
const SETUP_STEPS = 3;

/** verified -> funded (SiegeVault.createVault) -> guarding. Skips whatever is already done. */
async function driveToGuarding(
  castleId: string,
  potTinybar: number,
  durationSec: number,
  onStep: (k: number, label: string) => Promise<void> = async () => {},
): Promise<void> {
  let row = castleRow(castleId);
  if (!row) throw new Error("castle_missing");
  if (row.vaultState === "created" && row.transport === "hosted") {
    const t = await transitionVault(castleId, "verified", "hosted guard ready");
    if (!t.ok) throw new Error(`transition_verified_failed: ${t.reason}`);
    row = castleRow(castleId)!;
  }
  if (row.vaultState === "verified") {
    await onStep(2, "vault");
    if (row.vaultId != null && row.status === "open" && row.createVaultTx && !row.createVaultTx.startsWith("pending:")) {
      // The vault was created on chain but the funded transition did not land: do not create a second one.
      const t = await transitionVault(castleId, "funded", `vault #${row.vaultId} funded with ${row.potTinybar}`);
      if (!t.ok) throw new Error(`transition_funded_failed: ${t.reason}`);
    } else {
      const f = await fundVault(castleId, { potTinybar, durationSec });
      if (!f.ok) throw new Error(`fund_vault_failed: ${f.reason}`);
    }
    row = castleRow(castleId)!;
  }
  if (row.vaultState === "funded") {
    await onStep(3, "guard live");
    const t = await transitionVault(castleId, "guarding", "guard live");
    if (!t.ok) throw new Error(`transition_guarding_failed: ${t.reason}`);
  }
  // guarding / dormant / broken / closed: nothing left to do.
}

function noteOverpay(intent: DepositIntent, pot: number): void {
  if (intent.receivedTinybar <= pot) return;
  noteIntent(intent.id, `overpaid: ${intent.receivedTinybar - pot} tinybar above the pot cap, refund manually`);
}

/** kind "vault": the owner's deposit landed -> castle row, topic, verified, funded, guarding. */
export async function fundVaultFromDeposit(intent: DepositIntent): Promise<void> {
  const draft = db().select().from(schema.vaultDrafts).where(eq(schema.vaultDrafts.id, intent.refId)).get();
  if (!draft) throw new Error("draft_missing");
  const form = JSON.parse(draft.form) as DraftForm;
  const castleId = draft.castleId;
  if (!intent.payer) throw new Error("no_payer");
  const pot = Math.min(intent.receivedTinybar, env().PUBLISH_MAX_POT);

  const existing = castleRow(castleId);
  if (existing && existing.depositTx && existing.depositTx !== firstTx(intent.txs)) {
    // Another deposit (e.g. paid to an earlier window's memo) already set this vault up: nothing to fund.
    noteIntent(intent.id, `not_fundable: vault ${castleId} was already funded by another deposit, refund manually`);
    return;
  }
  const step = (k: number, label: string) => setIntentStep(intent.id, k, SETUP_STEPS, label);
  await step(1, "topic");
  if (!existing) {
    const now = Date.now();
    db()
      .insert(schema.castles)
      .values({
        id: castleId,
        name: form.name,
        guardianName: form.guardName,
        personality: form.voice,
        tier: "stone",
        orders: form.orders,
        feeTinybar: draft.feeTinybar,
        potTinybar: pot,
        asset: "0.0.0",
        status: "open",
        owner: intent.payer,
        protectedTool: form.protectedTool,
        vaultState: "created",
        transport: "hosted",
        deadline: now + draft.days * DAY_MS,
        createdAt: new Date(now).toISOString(),
        published: true,
        blurb: form.blurb || null,
        tools: JSON.stringify(form.tools),
        ownerKeyHash: draft.ownerKeyHash,
        depositTx: firstTx(intent.txs),
        zgApiKey: form.zg.apiKey,
        zgMgmtKey: form.zg.mgmtKey,
        zgKeyId: form.zg.keyId,
      })
      .run();
  }
  noteOverpay(intent, pot);
  await ensureTopic(castleId);
  await driveToGuarding(castleId, pot, draft.days * 86_400, step);
}

/** kind "vault-sdk": the owner funds a verified SDK castle (the deposit's payer must be the castle owner). */
export async function fundSdkVaultFromDeposit(intent: DepositIntent): Promise<void> {
  const row = castleRow(intent.refId);
  if (!row) throw new Error("castle_missing");
  if (row.transport !== "sdk") throw new Error("not_sdk");
  if (!intent.payer || intent.payer !== row.owner) throw new Error("payer_is_not_owner");
  // Only a verified vault (or one this deposit already funded, on a retry) takes the money. A second
  // FUND, or a deposit landing after the vault closed / went dormant / broke, is kept: say so.
  const resuming = row.vaultState === "funded" || (row.vaultState === "verified" && row.createVaultTx?.startsWith("pending:"));
  if (row.vaultState !== "verified" && !resuming) {
    noteIntent(intent.id, `not_fundable: vault is ${row.vaultState}, refund manually`);
    return;
  }
  if (row.depositTx && row.depositTx !== firstTx(intent.txs)) {
    noteIntent(intent.id, "not_fundable: vault was already funded by another deposit, refund manually");
    return;
  }
  const pot = Math.min(intent.receivedTinybar, env().PUBLISH_MAX_POT);
  noteOverpay(intent, pot);
  const step = (k: number, label: string) => setIntentStep(intent.id, k, SETUP_STEPS, label);
  await step(1, "topic");
  // The topic is paid by the arena only once the owner's deposit landed (not at publish time).
  await ensureTopic(row.id);
  if (!row.depositTx) db().update(schema.castles).set({ depositTx: firstTx(intent.txs) }).where(eq(schema.castles.id, row.id)).run();
  // The deadline was set from `days` at publish time: its distance to createdAt is the vault's duration.
  const durationSec = Math.max(3600, Math.round((row.deadline - Date.parse(row.createdAt)) / 1000));
  await driveToGuarding(row.id, pot, durationSec, step);
}

let registered = false;
/** Register both handlers (idempotent; tests that resetDepositHandlers() call it again with force). */
export function registerPublishHandlers(force = false): void {
  if (registered && !force) return;
  registered = true;
  onDepositConfirmed("vault", fundVaultFromDeposit);
  onDepositConfirmed("vault-sdk", fundSdkVaultFromDeposit);
}

registerPublishHandlers();
