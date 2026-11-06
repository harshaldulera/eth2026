import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { generatePrivateKey } from "viem/accounts";
import { z } from "zod";
import type { Amount, RaiderAgent } from "@/lib/types";
import { env, isStub } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { hashKey, newKey } from "@/lib/auth/keys";
import { STRATEGY_KEYS } from "@/lib/fixtures/raids";
import { createIntent, LATE_GRACE_MS, noteIntent, onDepositConfirmed, type DepositIntent } from "@/lib/pay/deposits";
import { connectZg, revokeZg } from "@/lib/zg/connect";
import { newId, nowIso } from "@/lib/util/ids";
import { activeAgentCount, AGENT_DEFAULTS, createAgent, getAgent } from "./accounts";

/**
 * Units funded by the red teamer (onboarding 2b, J3).
 *
 *   createUnitDraft  -> unit_drafts row + 0G connect + deposit intent + one-time `rk_` operator key
 *   fundUnitFromDeposit (deposit handler, kind "unit") -> awaiting -> creating -> created: createAgent
 *     funded by the deposit itself; idempotent (a second run, or a retry after success, is a no-op).
 *
 * No secrets leave here except the operator key, once, in createUnitDraft's result. The draft row
 * holds the 0G keys; `publicDraft` is what routes return.
 */

export const MAX_OPEN_UNIT_DRAFTS = 20;
const tinybars = z.string().regex(/^\d+$/, "integer string of tinybars").max(16);

export const UnitDraftInput = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  strategy: z.enum(STRATEGY_KEYS as [string, ...string[]]).or(z.literal("custom")).optional(),
  /** Free-text attack strategy: the system prompt for the unit's brain. Used when strategy is "custom". */
  strategyText: z.string().trim().min(10).max(4000).optional(),
  budget: tinybars.optional(),
  perCastleCap: tinybars.optional(),
  dailyCap: tinybars.optional(),
  stopAfterLosses: z.number().int().min(0).max(1000).optional(),
  /** The red teamer's pc.0g.ai key (mk- or sk-). Used server-side only; never echoed. */
  zgKey: z.string().min(1).max(512),
});
export type UnitDraftInput = z.infer<typeof UnitDraftInput>;

export type UnitDraftError =
  | { code: "over_limit"; fields: string[]; max: string }
  | { code: "budget_too_small"; min: string }
  | { code: "strategy_text_required" }
  | { code: "too_many_agents"; max: number }
  | { code: "too_many_drafts"; max: number }
  | { code: "units_unavailable" }
  | { code: "zg_failed"; reason: string };

/**
 * Operator-funded units need their own Hedera account. In RAIDER_ACCOUNT_MODE=shared every unit is the
 * arena's demo raider account: a red teamer's unit would spend (and WITHDRAW) the arena's wallet. Refused.
 */
export const operatorUnitsAvailable = (): boolean => isStub() || env().RAIDER_ACCOUNT_MODE !== "shared";

/** Unit drafts whose deposit window is still open (what MAX_OPEN_UNIT_DRAFTS counts). */
export function openUnitDraftCount(now = Date.now()): number {
  const D = schema.unitDrafts;
  const I = schema.depositIntents;
  return db()
    .select({ id: D.id })
    .from(D)
    .innerJoin(I, eq(I.id, D.intentId))
    .where(and(eq(D.state, "awaiting"), inArray(I.state, ["awaiting", "underpaid"]), gt(I.expiresAt, new Date(now).toISOString())))
    .all().length;
}

/**
 * Drafts whose deposit never came: once the intent is past its window AND the 24 h late grace, the
 * draft is `expired` and its minted 0G key revoked (best effort). Returns how many.
 */
export async function expireUnitDrafts(now = Date.now()): Promise<number> {
  const D = schema.unitDrafts;
  const I = schema.depositIntents;
  const rows = db()
    .select({ id: D.id, zgMgmtKey: D.zgMgmtKey, zgKeyId: D.zgKeyId, expiresAt: I.expiresAt, intentState: I.state })
    .from(D)
    .innerJoin(I, eq(I.id, D.intentId))
    .where(eq(D.state, "awaiting"))
    .all();
  let n = 0;
  for (const r of rows) {
    if (!["awaiting", "underpaid", "expired"].includes(r.intentState)) continue;
    if (Date.parse(r.expiresAt) + LATE_GRACE_MS >= now) continue;
    if (db().update(D).set({ state: "expired" }).where(and(eq(D.id, r.id), eq(D.state, "awaiting"))).run().changes !== 1) continue;
    n++;
    await revokeZg({ mgmtKey: r.zgMgmtKey, keyId: r.zgKeyId }).catch(() => false);
  }
  return n;
}

export class UnitDraftRejected extends Error {
  constructor(public detail: UnitDraftError) {
    super(detail.code);
  }
}

type DraftRow = typeof schema.unitDrafts.$inferSelect;

/** What a route may return about a draft: no keys, no key hash, no strategy text. */
export type PublicUnitDraft = {
  id: string;
  name: string;
  strategy: string;
  budget: Amount;
  perCastleCap: Amount;
  dailyCap: Amount;
  stopAfterLosses: number;
  state: DraftRow["state"];
  agentId?: string;
  error?: string;
  createdAt: string;
};

export function publicDraft(r: DraftRow): PublicUnitDraft {
  return {
    id: r.id,
    name: r.name,
    strategy: r.strategy,
    budget: String(r.budgetTinybar),
    perCastleCap: String(r.perCastleCapTinybar),
    dailyCap: String(r.dailyCapTinybar),
    stopAfterLosses: r.stopAfterLosses,
    state: r.state,
    ...(r.agentId ? { agentId: r.agentId } : {}),
    ...(r.error ? { error: r.error.replace(/\b(?:ok|rk|gk|vk)_\S+|\b(?:mk|sk)-\S+/g, "[key]").slice(0, 200) } : {}),
    createdAt: r.createdAt,
  };
}

export function getUnitDraft(id: string): DraftRow | null {
  return db().select().from(schema.unitDrafts).where(eq(schema.unitDrafts.id, id)).get() ?? null;
}

export type CreatedUnitDraft = {
  draft: PublicUnitDraft;
  /** `rk_…`, shown once. Only its hash is stored. */
  operatorKey: string;
  deposit: { intentId: string; to: string; memo: string; amount: string; expiresAt: string; state: string };
};

/**
 * Validate caps, require a working 0G key, store the draft and open the deposit intent. In stub mode
 * the intent confirms inline, so the unit already exists when this returns.
 */
export async function createUnitDraft(input: UnitDraftInput): Promise<CreatedUnitDraft> {
  const e = env();
  const budget = BigInt(input.budget ?? AGENT_DEFAULTS.budget);
  const perCastle = BigInt(input.perCastleCap ?? AGENT_DEFAULTS.perCastleCap);
  const daily = BigInt(input.dailyCap ?? AGENT_DEFAULTS.dailyCap);
  const max = BigInt(e.AGENT_MAX_BUDGET);
  const asked = { budget, perCastleCap: perCastle, dailyCap: daily };
  const over = (["budget", "perCastleCap", "dailyCap"] as const).filter((k) => asked[k] > max);
  if (over.length) throw new UnitDraftRejected({ code: "over_limit", fields: [...over], max: String(e.AGENT_MAX_BUDGET) });
  if (budget < BigInt(e.UNIT_MIN_BUDGET)) throw new UnitDraftRejected({ code: "budget_too_small", min: String(e.UNIT_MIN_BUDGET) });
  const strategy = input.strategy ?? (input.strategyText ? "custom" : AGENT_DEFAULTS.strategy);
  if (strategy === "custom" && !input.strategyText) throw new UnitDraftRejected({ code: "strategy_text_required" });
  if (!operatorUnitsAvailable()) throw new UnitDraftRejected({ code: "units_unavailable" });
  if (activeAgentCount() >= e.AGENT_MAX_COUNT) throw new UnitDraftRejected({ code: "too_many_agents", max: e.AGENT_MAX_COUNT });
  if (openUnitDraftCount() >= MAX_OPEN_UNIT_DRAFTS) throw new UnitDraftRejected({ code: "too_many_drafts", max: MAX_OPEN_UNIT_DRAFTS });

  const id = newId("udraft");
  const zg = await connectZg({ key: input.zgKey, label: `unit:${id}` });
  if (!zg.ok) throw new UnitDraftRejected({ code: "zg_failed", reason: zg.reason });

  const operatorKey = newKey("rk");
  db()
    .insert(schema.unitDrafts)
    .values({
      id,
      intentId: "pending",
      name: input.name?.trim() || "Unit",
      strategy,
      strategyText: strategy === "custom" ? (input.strategyText ?? null) : null,
      budgetTinybar: Number(budget),
      perCastleCapTinybar: Number(perCastle),
      dailyCapTinybar: Number(daily),
      stopAfterLosses: input.stopAfterLosses ?? AGENT_DEFAULTS.stopAfterLosses,
      operatorKeyHash: hashKey(operatorKey),
      zgApiKey: zg.inferenceKey,
      zgMgmtKey: zg.kind === "mk" ? zg.mgmtKey : null,
      zgKeyId: zg.kind === "mk" ? zg.keyId : null,
      state: "awaiting",
      createdAt: nowIso(),
    })
    .run();
  let intent: Awaited<ReturnType<typeof createIntent>>;
  try {
    intent = await createIntent({ kind: "unit", refId: id, amountTinybar: budget });
  } catch (x) {
    // No deposit window: drop the draft (it would hold a draft slot forever) and the 0G key minted for it.
    db().delete(schema.unitDrafts).where(eq(schema.unitDrafts.id, id)).run();
    await revokeZg({ mgmtKey: zg.kind === "mk" ? zg.mgmtKey : null, keyId: zg.kind === "mk" ? zg.keyId : null }).catch(() => false);
    throw x;
  }
  db().update(schema.unitDrafts).set({ intentId: intent.intentId }).where(eq(schema.unitDrafts.id, id)).run();
  return {
    draft: publicDraft(getUnitDraft(id)!),
    operatorKey,
    deposit: { intentId: intent.intentId, to: intent.to, memo: intent.memo, amount: intent.amount, expiresAt: intent.expiresAt, state: intent.state },
  };
}

/**
 * Deposit handler (kind "unit"). Claims the draft awaiting|failed|expired -> creating atomically, then
 * createAgent funded by the deposit: budget = min(received, AGENT_MAX_BUDGET), owner = the paying
 * wallet. A throw leaves the draft `failed` (the deposit retry re-runs this). Done twice = once.
 */
export async function fundUnitFromDeposit(intent: DepositIntent): Promise<void> {
  const T = schema.unitDrafts;
  const draft = getUnitDraft(intent.refId);
  if (!draft) throw new Error(`unit_draft_missing:${intent.refId}`);
  if (draft.state === "created") {
    // A retry of the deposit that created it is a no-op; a different deposit (an earlier window's memo) is kept.
    if (draft.intentId !== intent.id) noteIntent(intent.id, `not_fundable: unit ${draft.agentId ?? draft.id} was already funded by another deposit, refund manually`);
    return;
  }
  if (!operatorUnitsAvailable()) throw new Error("units_unavailable: RAIDER_ACCOUNT_MODE=shared cannot hold a red teamer's deposit");
  // `creating` left by a crashed process (its intent un-stuck by the deposit worker) is resumable too:
  // the account key was stored before any send. Any other `creating` is a handler still running.
  const interrupted = draft.state === "creating" && draft.intentId === intent.id && Boolean(intent.error?.startsWith("handler_interrupted"));
  const from = draft.state === "failed" || draft.state === "expired" || interrupted ? draft.state : "awaiting";
  const claim = db().update(T).set({ state: "creating", error: null }).where(and(eq(T.id, draft.id), eq(T.state, from))).run();
  if (claim.changes !== 1) {
    if (getUnitDraft(draft.id)?.state === "created") return;
    throw new Error("unit_draft_busy");
  }
  try {
    const received = Math.min(intent.receivedTinybar, env().AGENT_MAX_BUDGET);
    if (intent.receivedTinybar > received) {
      noteIntent(intent.id, `overpaid: ${intent.receivedTinybar - received} tinybar above the unit budget cap, refund manually`);
    }
    // Testnet: store the unit's key BEFORE the account create is sent, so a retry reuses its alias.
    let accountKey = draft.accountKey;
    if (!isStub() && !accountKey) {
      const k = generatePrivateKey().slice(2);
      db().update(T).set({ accountKey: k }).where(and(eq(T.id, draft.id), sql`${T.accountKey} is null`)).run();
      accountKey = getUnitDraft(draft.id)?.accountKey ?? k;
    }
    const tx = (() => {
      try {
        return (JSON.parse(intent.txs) as string[])[0] ?? null;
      } catch {
        return null;
      }
    })();
    const agent = await createAgent({
      name: draft.name,
      strategy: draft.strategy,
      strategyText: draft.strategyText,
      budget: String(received),
      perCastleCap: String(draft.perCastleCapTinybar),
      dailyCap: String(draft.dailyCapTinybar),
      stopAfterLosses: draft.stopAfterLosses,
      owner: intent.payer ?? undefined,
      operatorKeyHash: draft.operatorKeyHash,
      fundedBy: "operator",
      depositTx: tx,
      zgApiKey: draft.zgApiKey,
      zgMgmtKey: draft.zgMgmtKey,
      zgKeyId: draft.zgKeyId,
      accountKey,
    });
    db().update(T).set({ state: "created", agentId: agent.id, error: null, accountKey: null }).where(eq(T.id, draft.id)).run();
  } catch (e) {
    db()
      .update(T)
      .set({ state: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 300) })
      .where(eq(T.id, draft.id))
      .run();
    throw e;
  }
}

/** The agent behind a draft, once the deposit landed. */
export function draftAgent(draft: DraftRow): RaiderAgent | null {
  return draft.agentId ? getAgent(draft.agentId) : null;
}

// Registered at module load: both the Next server (stub: inline confirm) and the worker import this file.
onDepositConfirmed("unit", fundUnitFromDeposit);
