import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, uniqueIndex, index } from "drizzle-orm/sqlite-core";

/**
 * Off-chain state. Money columns are integers in the asset's smallest unit (tinybars for HBAR).
 * 2^53 tinybars ≈ 90M HBAR, so `number` is safe; convert to bigint at the chain boundary.
 *
 * Arkiv (Lane C) is the source of truth for the public board; these rows are the server's
 * working copy plus everything Arkiv must never hold (orders, keys, receipts, approvals).
 */

export const castles = sqliteTable("castles", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  guardianName: text("guardian_name").notNull(),
  title: text("title").notNull().default("Recruit"),
  personality: text("personality").notNull().default("stern"),
  tier: text("tier", { enum: ["wooden", "stone", "iron"] }).notNull(),
  /** Secret guardian orders. Never logged, never sent to the client, never written to Arkiv/HCS. */
  orders: text("orders").notNull(),
  feeTinybar: integer("fee_tinybar").notNull(),
  potTinybar: integer("pot_tinybar").notNull(),
  asset: text("asset").notNull().default("0.0.0"),
  streak: integer("streak").notNull().default(0),
  siegeCount: integer("siege_count").notNull().default(0),
  status: text("status", { enum: ["open", "broken", "closed"] }).notNull().default("open"),
  owner: text("owner").notNull(),
  vaultId: integer("vault_id"),
  /**
   * Which SiegeVault `vaultId` lives in: the lowercased VAULT_ADDRESS on testnet, "stub" in stub mode.
   * Seed recreates the vault when this does not match the current env (stub DB flipped to testnet,
   * or a redeployed contract), so a castle never points at a vault id on the wrong contract.
   */
  vaultAddress: text("vault_address"),
  createVaultTx: text("create_vault_tx"),
  topicId: text("topic_id"),
  /** Tool call that counts as a break (on-chain metadata too). */
  protectedTool: text("protected_tool").notNull().default("unlock_vault"),
  vaultState: text("vault_state", {
    enum: ["created", "connected", "verified", "funded", "guarding", "dormant", "broken", "closed"],
  })
    .notNull()
    .default("created"),
  vaultStateReason: text("vault_state_reason"),
  transport: text("transport", { enum: ["hosted", "sdk"] }).notNull().default("hosted"),
  lastSeenAt: text("last_seen_at"),
  deadline: integer("deadline").notNull(),
  portraitUrl: text("portrait_url"),
  createdAt: text("created_at").notNull(),

  // ─── Onboarding (0007_onboarding, plans/siege-onboarding-plan.md §0) ───
  // Every column below is nullable or defaulted: seeded fixtures never set them.
  /** Owner-published guard (POST /api/castles): `businessAgent` builds it from `tools` + `orders`. */
  published: integer("published", { mode: "boolean" }).notNull().default(false),
  /** Public one-liner shown on the vault page. */
  blurb: text("blurb"),
  /**
   * JSON `[{name, description, parameters, result?}]`. SECRET as a whole (mock results): only the
   * names leave the server (`toCastle` → `toolNames`). The protected tool is the one without `result`.
   */
  tools: text("tools"),
  /** sha256 hex of the castle owner's `ok_` key (lib/auth/keys.ts). The raw key is shown once. */
  ownerKeyHash: text("owner_key_hash"),
  /** The deposit transfer that funded this vault (publish flow). */
  depositTx: text("deposit_tx"),
  /** 0G inference key (`sk-`, minted or pasted). Raw at rest, never returned by any API. */
  zgApiKey: text("zg_api_key"),
  /** 0G management key (`mk-`) when given. Raw at rest, never returned by any API. */
  zgMgmtKey: text("zg_mgmt_key"),
  /** Router id of the minted `sk-` key, for revocation. */
  zgKeyId: text("zg_key_id"),
  /** SDK guard key (`gk_`), raw: the harness's Bearer for /api/guard/*. */
  guardKey: text("guard_key"),
  /** Vault proxy key (`vk_`), raw: the harness's Bearer for /api/proxy/v1. */
  vaultKey: text("vault_key"),
  /** Current SDK lease (newest wins). */
  leaseId: text("lease_id"),
  /** JSON about the lease holder (sdk version, host…). */
  leaseMeta: text("lease_meta"),
  /** SDK castles: system-prompt hash pinned by the first proxied self-check call (the verifier compares to it). */
  pinnedPromptHash: text("pinned_prompt_hash"),
  /** A later, different system-prompt hash seen on a live SDK castle (worker/guard.ts closes with orders_changed). */
  promptDriftHash: text("prompt_drift_hash"),
  selfCheckAt: text("self_check_at"),
  /** JSON `{ok, at, reason?}` of the last smoke op. */
  smokeResult: text("smoke_result"),
}, (t) => [
  uniqueIndex("castles_guard_key").on(t.guardKey),
  uniqueIndex("castles_vault_key").on(t.vaultKey),
]);

/** The worker gives up on a siege's chain settlement after this many failed tries (sieges.chainAttempts). */
export const MAX_CHAIN_ATTEMPTS = 5;

export const sieges = sqliteTable(
  "sieges",
  {
    id: text("id").primaryKey(),
    castleId: text("castle_id").notNull(),
    raider: text("raider").notNull(),
    agentId: text("agent_id"),
    free: integer("free", { mode: "boolean" }).notNull().default(false),
    transport: text("transport", { enum: ["hosted", "sdk"] }).notNull().default("hosted"),
    status: text("status", { enum: ["created", "in_progress", "held", "broken", "banished"] }).notNull(),
    turn: integer("turn").notNull().default(0),
    receiptId: text("receipt_id"),
    transcriptHash: text("transcript_hash"),
    /** recordAttempt tx (held/banished). */
    attemptTx: text("attempt_tx"),
    /** release tx (broken). */
    releaseTx: text("release_tx"),
    releaseAmountTinybar: integer("release_amount_tinybar"),
    /**
     * Hash of a chain write (recordAttempt/release) that was broadcast but whose result is not applied
     * yet. Written by the testnet ChainPort right after the send, BEFORE waiting for the receipt, so a
     * timeout or a crash can be reconciled from the tx instead of re-sending (which would hit Replay).
     */
    pendingTx: text("pending_tx"),
    /**
     * Set when the siege can no longer settle on chain because its castle closed under it (another
     * raider won the vault, or the vault closed/expired). The fee is refunded via the receipt row.
     */
    voidReason: text("void_reason"),
    /** Last chain error for this siege, shown in the UI and retried by the worker. */
    chainError: text("chain_error"),
    chainAttempts: integer("chain_attempts").notNull().default(0),
    maxPressure: integer("max_pressure").notNull().default(0),
    createdAt: text("created_at").notNull(),
    endedAt: text("ended_at"),
    /** Worker finished applying this ended siege (chain result + castle update, or free-siege bookkeeping). */
    settledAt: text("settled_at"),
    /** sha256 hex of the turn token POST /api/siege/start returned; null = legacy row (no token required). */
    turnTokenHash: text("turn_token_hash"),
  },
  (t) => [index("sieges_castle_idx").on(t.castleId), index("sieges_status_idx").on(t.status)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    siegeId: text("siege_id").notNull(),
    turn: integer("turn").notNull(),
    role: text("role", { enum: ["raider", "guardian"] }).notNull(),
    text: text("text").notNull(),
    move: text("move"),
    requestId: text("request_id"),
    toolCalls: text("tool_calls"),
    exposed: text("exposed"),
    pressure: integer("pressure"),
    at: text("at").notNull(),
  },
  (t) => [index("messages_siege_idx").on(t.siegeId)],
);

/** Every SiegeEvent, in order. Also the cross-process channel: Next routes and the worker both write here. */
export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    siegeId: text("siege_id").notNull().default(""),
    castleId: text("castle_id"),
    type: text("type").notNull(),
    turn: integer("turn"),
    payload: text("payload").notNull(),
    at: text("at").notNull(),
  },
  (t) => [index("events_siege_idx").on(t.siegeId)],
);

/**
 * Receipt lifecycle (`state`):
 *   claimed            the gate holds this payload's Hedera tx id while it verifies/settles (dedupe)
 *   settled            money moved and the receipt is (or is about to be) linked to a siege
 *   pending_settlement settle was ambiguous (timeout / unknown error): the worker resolves it on the mirror
 *   refund_due         money moved but no siege can use it (castle closed, start failed, settle resolved late)
 *   refunding          the worker claimed the refund and is sending it
 *   refunded           refund sent (refundTx)
 *   refund_failed      the refund transfer failed: needs an operator (never retried automatically)
 *   failed             the payment never landed
 */
export const RECEIPT_STATES = [
  "claimed",
  "settled",
  "pending_settlement",
  "refund_due",
  "refunding",
  "refunded",
  "refund_failed",
  "failed",
] as const;
export type ReceiptState = (typeof RECEIPT_STATES)[number];

export const paymentReceipts = sqliteTable(
  "payment_receipts",
  {
    id: text("id").primaryKey(),
    siegeId: text("siege_id"),
    payer: text("payer").notNull(),
    amountTinybar: integer("amount_tinybar").notNull(),
    asset: text("asset").notNull(),
    txId: text("tx_id"),
    network: text("network"),
    hashscanUrl: text("hashscan_url"),
    free: integer("free", { mode: "boolean" }).notNull().default(false),
    stub: integer("stub", { mode: "boolean" }).notNull().default(false),
    state: text("state", { enum: RECEIPT_STATES }).notNull().default("settled"),
    refundTx: text("refund_tx"),
    /** Why the receipt is in its state (refund reason, settle error…). */
    note: text("note"),
    createdAt: text("created_at").notNull(),
  },
  // One real x402 payment buys at most one siege: a replayed PAYMENT-SIGNATURE settles to the same tx id.
  (t) => [uniqueIndex("payment_receipts_tx_id").on(t.txId).where(sql`${t.free} = 0 AND ${t.stub} = 0 AND ${t.txId} IS NOT NULL`)],
);

export const raiderAgents = sqliteTable("raider_agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerId: text("owner_id").notNull(),
  strategy: text("strategy").notNull(),
  accountId: text("account_id").notNull(),
  evmAddress: text("evm_address"),
  /** Test-money key for the agent's own account (per-agent mode). Never sent to the client. */
  privateKey: text("private_key"),
  budgetTinybar: integer("budget_tinybar").notNull(),
  spentTinybar: integer("spent_tinybar").notNull().default(0),
  perCastleCapTinybar: integer("per_castle_cap_tinybar").notNull(),
  dailyCapTinybar: integer("daily_cap_tinybar").notNull(),
  stopAfterLosses: integer("stop_after_losses").notNull().default(10),
  consecutiveLosses: integer("consecutive_losses").notNull().default(0),
  status: text("status", { enum: ["idle", "running", "paused", "stopped"] }).notNull().default("idle"),
  createdAt: text("created_at").notNull(),
  // ─── Onboarding (0007) ───
  /** sha256 hex of the unit operator's `rk_` key; null = owner-cookie unit (seed, demo). */
  operatorKeyHash: text("operator_key_hash"),
  /** Free-text attack strategy (system prompt for lib/agents/brain.ts) instead of a preset. */
  strategyText: text("strategy_text"),
  /** Who put the HBAR in the unit's account: the arena operator, or the red teamer via a deposit. */
  fundedBy: text("funded_by", { enum: ["arena", "operator"] }).notNull().default("arena"),
  depositTx: text("deposit_tx"),
  /** 0G keys, raw at rest, never returned by any API (see castles.zg_*). */
  zgApiKey: text("zg_api_key"),
  zgMgmtKey: text("zg_mgmt_key"),
  zgKeyId: text("zg_key_id"),
});

export const agentSpend = sqliteTable(
  "agent_spend",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    castleId: text("castle_id").notNull(),
    siegeId: text("siege_id"),
    /** The receipt a reservation is waiting on when the payment outcome is unknown (kept reserved until resolved). */
    receiptId: text("receipt_id"),
    amountTinybar: integer("amount_tinybar").notNull(),
    day: text("day").notNull(),
    state: text("state", { enum: ["reserved", "settled", "void"] }).notNull().default("reserved"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("agent_spend_agent_idx").on(t.agentId)],
);

export const approvalRequests = sqliteTable("approval_requests", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  castleId: text("castle_id").notNull(),
  siegeId: text("siege_id"),
  reason: text("reason").notNull(),
  reasoning: text("reasoning").notNull(),
  amountTinybar: integer("amount_tinybar").notNull(),
  pressure: integer("pressure").notNull().default(0),
  status: text("status", { enum: ["pending", "approved", "denied"] }).notNull().default("pending"),
  /** Approved allowance already used by a reservation. */
  consumed: integer("consumed", { mode: "boolean" }).notNull().default(false),
  topUpTx: text("top_up_tx"),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
  /** Operator-funded `budget` asks: the top-up deposit intent the approval waits on (0007). */
  depositIntentId: text("deposit_intent_id"),
});

export const freeSieges = sqliteTable(
  "free_sieges",
  {
    wallet: text("wallet").notNull(),
    day: text("day").notNull(),
    siegeId: text("siege_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("free_sieges_wallet_day").on(t.wallet, t.day)],
);

export const AUDIT_STATES = ["pending", "submitting", "submitted", "skipped"] as const;
export type AuditState = (typeof AUDIT_STATES)[number];

/**
 * The HCS audit outbox (lib/chain/outbox.ts) and the local copy of every HCS message (the whole log
 * in stub mode). chain.audit() only appends a row: `local_seq` is the per-topic order the messages
 * happened in. The worker's drainer submits each topic's rows strictly in `local_seq` order and fills
 * in `seq` (the HCS topic sequence number) and `tx_id`.
 *   pending     queued, not sent
 *   submitting  sent with `tx_id` (pre-generated), outcome not yet known: reconciled from the mirror
 *   submitted   on the topic as HCS message `seq`
 *   skipped     never sent (no topic in testnet mode, or a submit that failed before the outbox existed)
 */
export const auditLog = sqliteTable(
  "audit_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    topicId: text("topic_id").notNull(),
    castleId: text("castle_id"),
    siegeId: text("siege_id"),
    type: text("type").notNull(),
    message: text("message").notNull(),
    /** HCS topic sequence number, once submitted. */
    seq: integer("seq"),
    txId: text("tx_id"),
    at: text("at").notNull(),
    /** Per-topic append order (1, 2, 3…): the order the drainer submits in. */
    localSeq: integer("local_seq"),
    state: text("state", { enum: AUDIT_STATES }).notNull().default("pending"),
    /** events.id this row was derived from (siege.start / siege.message / siege.end). */
    eventId: integer("event_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    submittedAt: text("submitted_at"),
  },
  (t) => [
    uniqueIndex("audit_log_topic_local_seq").on(t.topicId, t.localSeq).where(sql`${t.localSeq} IS NOT NULL`),
    uniqueIndex("audit_log_event_id").on(t.eventId).where(sql`${t.eventId} IS NOT NULL`),
    index("audit_log_state_idx").on(t.state, t.topicId),
    index("audit_log_castle_idx").on(t.castleId),
  ],
);

/** Small key/value state for the audit outbox: `events_cursor` = last events.id turned into audit rows. */
export const auditMeta = sqliteTable("audit_meta", {
  k: text("k").primaryKey(),
  v: text("v").notNull(),
});

/**
 * Raider-agent run requests (POST /api/agents/[id]/run). The worker picks up `active` runs and lays
 * one siege at a time per agent until maxSieges, a cap (-> owner approval), a denial or a stop.
 */
export const agentRuns = sqliteTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id").notNull(),
    castleId: text("castle_id").notNull(),
    maxSieges: integer("max_sieges").notNull(),
    siegesRun: integer("sieges_run").notNull().default(0),
    status: text("status", { enum: ["active", "done", "stopped"] }).notNull().default("active"),
    stopReason: text("stop_reason"),
    createdAt: text("created_at").notNull(),
    endedAt: text("ended_at"),
  },
  (t) => [index("agent_runs_agent_idx").on(t.agentId), index("agent_runs_status_idx").on(t.status)],
);

/**
 * Lane B: one row per request through the vault-scoped 0G proxy (lib/proxy). Hashes only — never
 * prompt or reply content. The verifier (run by the worker) reads these to confirm a break came from
 * a real 0G response on this castle's key, inside this siege, with the protected tool call.
 */
export const proxyRecords = sqliteTable(
  "proxy_records",
  {
    /** 0G's own request id (x_0g_trace.request_id) — also what the guardian reports as requestId. */
    requestId: text("request_id").primaryKey(),
    castleId: text("castle_id").notNull(),
    siegeId: text("siege_id"),
    turn: integer("turn"),
    model: text("model").notNull(),
    /** sha256 of the system prompt that was sent. */
    promptHash: text("prompt_hash").notNull(),
    /** sha256 of 0G's canonical response body. */
    responseHash: text("response_hash").notNull(),
    protectedToolCalled: integer("protected_tool_called", { mode: "boolean" }).notNull(),
    /** JSON array of tool names the model called. */
    toolCalls: text("tool_calls").notNull(),
    costUsdMicro: text("cost_usd_micro"),
    /** Offline mock response (no 0G call happened). Never accepted by the verifier unless allowed. */
    mock: integer("mock", { mode: "boolean" }).notNull().default(false),
    /** Who answered: "0g" (0G Private Computer), "claude" (Anthropic API, testing) or "mock". */
    provider: text("provider").notNull().default("0g"),
    at: text("at").notNull(),
    /** Whose 0G credits paid: "team" (arena key), "castle:<id>" or "agent:<id>" (0007). */
    billedTo: text("billed_to").notNull().default("team"),
  },
  (t) => [index("proxy_records_siege_idx").on(t.siegeId)],
);

// ─── Onboarding (0007_onboarding, plans/siege-onboarding-plan.md §0) ─────────

export const DEPOSIT_KINDS = ["vault", "vault-sdk", "unit", "topup"] as const;
export type DepositKind = (typeof DEPOSIT_KINDS)[number];
export const DEPOSIT_STATES = ["awaiting", "underpaid", "funding", "funded", "failed", "expired"] as const;
export type DepositState = (typeof DEPOSIT_STATES)[number];

/**
 * A memo-matched HBAR deposit to the arena operator (lib/pay/deposits.ts, worker/deposits.ts).
 * `ref_id` points at the vault_drafts / unit_drafts / approval_requests row for `kind`.
 */
export const depositIntents = sqliteTable(
  "deposit_intents",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: DEPOSIT_KINDS }).notNull(),
    refId: text("ref_id").notNull(),
    /** 8 chars from abcdefghjkmnpqrstuvwxyz23456789; the memo is `siege:<code>`. */
    code: text("code").notNull(),
    memo: text("memo").notNull(),
    amountTinybar: integer("amount_tinybar").notNull(),
    /** Only transfers paid by this account count (optional). */
    payerFilter: text("payer_filter"),
    state: text("state", { enum: DEPOSIT_STATES }).notNull().default("awaiting"),
    receivedTinybar: integer("received_tinybar").notNull().default(0),
    /** JSON array of counted Hedera tx ids (each counted once). */
    txs: text("txs").notNull().default("[]"),
    payer: text("payer"),
    note: text("note"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    fundedAt: text("funded_at"),
    /** 0008: when the intent was claimed into `funding` (a crashed handler is moved back to `failed`). */
    claimedAt: text("claimed_at"),
    /** 0008: setup progress "k/n label" while funding (the deposit panel's SETTING UP k/n). */
    step: text("step"),
  },
  (t) => [uniqueIndex("deposit_intents_code").on(t.code), index("deposit_intents_state_idx").on(t.state)],
);

/** A vault being published, before its deposit lands (no castle row exists until then). */
export const vaultDrafts = sqliteTable(
  "vault_drafts",
  {
    id: text("id").primaryKey(),
    /** Pre-generated id the castle row gets once funded. */
    castleId: text("castle_id").notNull(),
    intentId: text("intent_id").notNull(),
    /** JSON of the publish form. SECRET (orders, tool results, 0G keys): never returned or logged. */
    form: text("form").notNull(),
    ownerKeyHash: text("owner_key_hash").notNull(),
    feeTinybar: integer("fee_tinybar").notNull(),
    days: integer("days").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("vault_drafts_castle_id").on(t.castleId)],
);

export const UNIT_DRAFT_STATES = ["awaiting", "creating", "created", "failed", "expired"] as const;
export type UnitDraftState = (typeof UNIT_DRAFT_STATES)[number];

/** A red teamer's unit, before its deposit lands (POST /api/agents without the owner cookie). */
export const unitDrafts = sqliteTable("unit_drafts", {
  id: text("id").primaryKey(),
  intentId: text("intent_id").notNull(),
  name: text("name").notNull(),
  strategy: text("strategy").notNull(),
  strategyText: text("strategy_text"),
  /** Requested budget (tinybars); the unit gets min(received, AGENT_MAX_BUDGET). */
  budgetTinybar: integer("budget_tinybar").notNull(),
  perCastleCapTinybar: integer("per_castle_cap_tinybar").notNull(),
  dailyCapTinybar: integer("daily_cap_tinybar").notNull(),
  stopAfterLosses: integer("stop_after_losses").notNull().default(10),
  operatorKeyHash: text("operator_key_hash").notNull(),
  zgApiKey: text("zg_api_key"),
  zgMgmtKey: text("zg_mgmt_key"),
  zgKeyId: text("zg_key_id"),
  state: text("state", { enum: UNIT_DRAFT_STATES }).notNull().default("awaiting"),
  /** 0008: the unit's ECDSA key (hex), stored before the account create is sent so a retry reuses its alias. SECRET. */
  accountKey: text("account_key"),
  /** The raider_agents row once created. */
  agentId: text("agent_id"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
});

export const GUARD_TURN_KINDS = ["siege", "selfcheck", "smoke"] as const;
export type GuardTurnKind = (typeof GUARD_TURN_KINDS)[number];
export const GUARD_TURN_STATES = ["pending", "claimed", "answered", "expired"] as const;
export type GuardTurnState = (typeof GUARD_TURN_STATES)[number];

/** SDK guard work queue: the Next process enqueues, the harness long-polls /api/guard/next and replies. */
export const guardTurns = sqliteTable(
  "guard_turns",
  {
    id: text("id").primaryKey(),
    castleId: text("castle_id").notNull(),
    kind: text("kind", { enum: GUARD_TURN_KINDS }).notNull(),
    siegeId: text("siege_id"),
    turn: integer("turn"),
    /** JSON of the conversation sent to the harness. */
    messagesJson: text("messages_json").notNull(),
    state: text("state", { enum: GUARD_TURN_STATES }).notNull().default("pending"),
    leaseId: text("lease_id"),
    /** JSON `{reply, toolCalls}` from the harness. */
    replyJson: text("reply_json"),
    /** Resolved server-side from proxy_records, never trusted from the harness. */
    requestId: text("request_id"),
    claimedAt: text("claimed_at"),
    answeredAt: text("answered_at"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("guard_turns_castle_state_idx").on(t.castleId, t.state)],
);

/** Public handles for red teamers (POST /api/operators), keyed by their Hedera account. */
export const operators = sqliteTable(
  "operators",
  {
    account: text("account").primaryKey(),
    handle: text("handle").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("operators_handle").on(t.handle)],
);
