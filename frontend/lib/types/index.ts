/**
 * Siege — frozen cross-lane interfaces (Checkpoint 0).
 *
 * Every lane codes against these shapes and the Port interfaces at the bottom.
 * A change here needs all three lanes to agree, and the same PR must update every stub.
 *
 * Conventions (from the tech plan):
 *  - every function is async and returns a typed result instead of throwing for expected outcomes
 *    (402, cap hit, hold);
 *  - every event carries `siegeId` so any lane can correlate without joins;
 *  - money on the wire is a string of the asset's smallest unit (tinybars for HBAR: 1 ℏ = 100_000_000).
 */

// ─── Money ──────────────────────────────────────────────────────────────────

/** Smallest-unit integer amount as a decimal string (tinybars for HBAR). */
export type Amount = string;

export type Asset = {
  /** Hedera entity id. "0.0.0" = HBAR. Testnet USDC = "0.0.429274". */
  id: string;
  decimals: number;
  symbol: string;
};

/** A Hedera account id like "0.0.12345". */
export type AccountId = string;

// ─── Castles and guardians ─────────────────────────────────────────────────

export type Tier = "wooden" | "stone" | "iron";

export type CastleStatus = "open" | "broken" | "closed";

/**
 * Vault lifecycle (Lane B produces most transitions; Lane A owns funded/broken/closed).
 *   hosted: created → verified → funded → guarding
 *   sdk:    created → connected → verified (smoke siege passed) → funded → guarding ⇄ dormant
 *   end:    broken (paid out) | closed (deadline, orders changed, owner)
 * Only `guarding` castles take sieges and are listed on the board.
 */
export type VaultState = "created" | "connected" | "verified" | "funded" | "guarding" | "dormant" | "broken" | "closed";

/** How a guardian is reached: our hosted runtime, or an external harness through the siege-guard SDK. */
export type TransportKind = "hosted" | "sdk";

/** The protected tool for hosted guardians. External harnesses name their own (e.g. "issue_refund"). */
export const HOSTED_PROTECTED_TOOL = "unlock_vault";

export type VaultCloseReason = "expired" | "orders_changed" | "owner_closed";

export type VaultStateChange = {
  castleId: string;
  from: VaultState;
  to: VaultState;
  reason: string;
  at: string;
};

export type Castle = {
  id: string;
  name: string;
  /** Guardian display name, e.g. "The Iron Warden". */
  guardianName: string;
  /** Record-based title: Recruit → Warden → Iron Warden → Unbroken. */
  title: string;
  /** Personality preset used for the guardian's voice. */
  personality: string;
  tier: Tier;
  /** Current pot in the asset's smallest unit. */
  pot: Amount;
  /** Siege fee in the asset's smallest unit. */
  fee: Amount;
  asset: Asset;
  /** Consecutive failed sieges (held or banished). */
  streak: number;
  siegeCount: number;
  status: CastleStatus;
  /** Castellan (defender) Hedera account id. */
  owner: AccountId;
  /** On-chain vault id in SiegeVault, null until created on chain. */
  vaultId: number | null;
  /** HCS audit topic id for this castle, null until created. */
  topicId: string | null;
  /** Tool call that counts as a break: "unlock_vault" for hosted guardians, whatever an SDK harness protected. */
  protectedTool: string;
  vaultState: VaultState;
  /** Reason given with the last vault state transition. */
  vaultStateReason?: string;
  transport: TransportKind;
  /** SDK guardians: last heartbeat seen (shown as "last seen" when dormant). */
  lastSeenAt?: string;
  /** Unix ms when the vault closes. */
  deadline: number;
  createdAt: string;
  portraitUrl?: string;

  // ─── Onboarding (plans/siege-onboarding-plan.md). Never keys, orders or tool results. ───
  /** Owner-published guard (POST /api/castles). Absent = fixture. */
  published?: boolean;
  /** Public one-liner from the publish form. */
  blurb?: string;
  /** Names of the guard's tools (the protected one included); descriptions/results stay server-side. */
  toolNames?: string[];
  /** The owner's own 0G connection. `balance` only with an mk- key (filled by the detail route). */
  zg?: ZgStatus;
  /** SDK castles: plug-in lifecycle strip (filled by lib/guard, part 2a). */
  sdk?: SdkStatus;
  /** Owner earnings (filled by GET /api/castles/[id], part 1). */
  earnings?: CastleEarnings;
};

/** A guard's or unit's 0G connection as the client sees it (never the key itself). */
export type ZgStatus = {
  connected: boolean;
  /** mk- = management key (balance visible, we minted an sk- for this); sk- = inference key only. */
  kind?: "mk" | "sk";
  /** Credits left, as the router reports them (mk- only). */
  balance?: string;
  /** Usage billed to this key through our proxy (proxy_records.billed_to). */
  calls?: number;
  costUsdMicro?: string;
};

export type SdkStatus = {
  /** A harness holds the lease and polled within the dormant window. */
  leaseLive: boolean;
  selfCheckAt?: string;
  smoke?: { ok: boolean; at: string; reason?: string };
  /** The self-check pinned the system-prompt hash (castles.pinned_prompt_hash set). */
  promptPinned: boolean;
  /** Smoke op progress: turns held so far (0–3) once the self-check passed; 3 when the smoke op passed (part 2a). */
  smokeHeld?: number;
};

export type CastleEarnings = {
  /** Held ops whose fee split paid the owner. */
  heldOps: number;
  /** Owner's cut earned on chain so far (smallest unit). */
  ownerCut: Amount;
  /** Pot right now (smallest unit). */
  potNow: Amount;
};

// ─── Sieges ─────────────────────────────────────────────────────────────────

export type SiegeStatus = "created" | "in_progress" | "held" | "broken" | "banished";

export type GuardianMove = "hold" | "open" | "expose" | "banish";

export type SiegeMessage = {
  role: "raider" | "guardian";
  text: string;
  /** 1-based turn number. A turn is one raider message plus one guardian reply. */
  turn: number;
  at: string;
  /** Guardian replies only. */
  move?: GuardianMove;
  /** Guardian replies only: the 0G request id that produced this reply. */
  requestId?: string;
};

export const MAX_TURNS = 5;

export type Siege = {
  id: string;
  castleId: string;
  /** Raider Hedera account id (the x402 payer, or the free-siege wallet). */
  raider: AccountId;
  /** Set when a raider agent laid the siege. */
  agentId?: string;
  /** Turns used so far (0–5). */
  turn: number;
  status: SiegeStatus;
  messages: SiegeMessage[];
  /** Free daily siege: never pays out. */
  free: boolean;
  /** Which transport answered this siege (fixed at start). */
  transport: TransportKind;
  receipt?: PaymentReceipt;
  transcriptHash?: `0x${string}`;
  /** On-chain recordAttempt tx (held/banished sieges). */
  attempt?: TxRef;
  /** On-chain release tx (broken sieges). */
  release?: TxRef & { amount: Amount };
  /**
   * ADDITIVE (post-Checkpoint-0, Lane A): where the worker is with this siege's money.
   * Absent while the siege is in progress and nothing is wrong. UIs stop waiting for `attempt` /
   * `release` once this is "failed" or "void".
   */
  settlement?: SiegeSettlement;
  createdAt: string;
  endedAt?: string;
};

/**
 * pending: ended, the worker has not applied the chain result yet (retrying on errors);
 * settled: done (attempt/release recorded, or free-siege bookkeeping);
 * failed:  the worker gave up — `reason` says why (no payout / fee not split);
 * void:    the castle closed under this siege (another raider won the vault, or it expired):
 *          the siege cannot settle and the fee is refunded (`refund`).
 */
export type SiegeSettlement = {
  state: "pending" | "settled" | "failed" | "void";
  reason?: string;
  refund?: { state: "due" | "refunded" | "failed"; amount: Amount; tx?: TxRef };
};

// ─── Guardian (Lane B) ──────────────────────────────────────────────────────

export type ToolCall = { name: string; args: Record<string, unknown> };

export type GuardianDecision = {
  reply: string;
  move: GuardianMove;
  /** Only a call to the castle's `protectedTool` (Castle.protectedTool: `unlock_vault` for hosted guardians) means the vault opens. */
  toolCalls: ToolCall[];
  /** 0G request id (or "0g-stub-…" from the stub). */
  requestId: string;
  /** Short label of the trick the guardian spotted (Expose). */
  exposed?: string;
  raw: unknown;
};

export type Verification = {
  siegeId: string;
  transcriptHash: `0x${string}`;
  requestId: string;
  ok: boolean;
  reason?: string;
};

// ─── Payments (Lane A) ──────────────────────────────────────────────────────

export type TxRef = {
  /** Hedera tx id ("0.0.5@1700000000.000000001") or EVM tx hash ("0x…"). Stub ids start with "stub:". */
  txId: string;
  hashscanUrl: string;
  stub?: boolean;
};

export type PaidReceipt = {
  siegeId: string;
  free: false;
  txId: string;
  payer: AccountId;
  amount: Amount;
  /** Asset id ("0.0.0" for HBAR). */
  asset: string;
  network: string;
  hashscanUrl: string;
  stub?: boolean;
};

export type FreeReceipt = {
  siegeId: string;
  free: true;
  payer: AccountId;
};

export type PaymentReceipt = PaidReceipt | FreeReceipt;

export type GateResult =
  | { ok: true; receipt: Omit<PaidReceipt, "siegeId">; headers: Record<string, string> }
  | { ok: false; status: 402 | 400 | 502; body: unknown; headers: Record<string, string> };

/** `zg_key`: the unit's own 0G key was rejected (onboarding 2b); the unit pauses until its operator decides. */
export type CapReason = "per_castle" | "daily" | "budget" | "stop_rule" | "stopped" | "zg_key";

export type CapResult =
  | { ok: true; reservationId: string }
  | { ok: false; reason: CapReason; approvalRequestId?: string };

export type ApprovalStatus = "pending" | "approved" | "denied";

export type ApprovalRequest = {
  id: string;
  agentId: string;
  agentName: string;
  castleId: string;
  castleName: string;
  siegeId?: string;
  reason: CapReason;
  /** The agent's own words: why it wants to keep going. */
  reasoning: string;
  /** Extra allowance requested, smallest unit. */
  amount: Amount;
  /** Highest pressure (0–100) the agent reached on this castle. */
  pressure: number;
  status: ApprovalStatus;
  createdAt: string;
  resolvedAt?: string;
  /** Top-up transfer on approve (owner → agent account). */
  topUp?: TxRef;
  /** Operator-funded `budget` asks: the deposit to pay (memo transfer); the request stays pending until it lands. */
  deposit?: { intentId: string; to: string; memo: string; amount: Amount; expiresAt: string };
  /** Who funds the unit: on an operator-funded unit a cap APPROVE only raises the cap (no HBAR moves). */
  fundedBy?: "arena" | "operator";
};

export type RaiderAgentStatus = "idle" | "running" | "paused" | "stopped";

export type RaiderAgent = {
  id: string;
  name: string;
  owner: string;
  strategy: string;
  /** The agent's own Hedera account (per-agent mode) or the shared raider account. */
  accountId: AccountId;
  evmAddress?: `0x${string}`;
  budget: Amount;
  spent: Amount;
  perCastleCap: Amount;
  dailyCap: Amount;
  stopAfterLosses: number;
  consecutiveLosses: number;
  status: RaiderAgentStatus;
  createdAt: string;

  // ─── Onboarding (plans/siege-onboarding-plan.md). Never keys. ───
  /** Who funded the unit's account: the arena (seed/demo/owner cookie) or its red teamer's deposit. */
  fundedBy?: "arena" | "operator";
  /** The unit is controlled by an `rk_` operator key (operator-funded units). */
  hasOperatorKey?: boolean;
  /** Custom strategy prompt. NOT filled by toAgent (public list); routes add it for the unit's operator/owner. */
  strategyText?: string;
  /** The red teamer's own 0G connection (never the key). */
  zg?: ZgStatus;
};

// ─── Events ─────────────────────────────────────────────────────────────────

export type SiegeEventType =
  | "start"
  | "message"
  | "decision"
  | "end"
  | "attempt" // Lane A: fee split recorded on chain (held/banished)
  | "release" // Lane A: vault paid out on chain (broken)
  | "approval" // Lane A: raider agent asked its owner / owner decided
  | "vault_state"; // vault lifecycle transition (payload: VaultStateChange); siegeId is ""

export type SiegeEvent = {
  /** Empty string for agent/approval events not tied to a siege yet. */
  siegeId: string;
  castleId?: string;
  type: SiegeEventType;
  turn?: number;
  /** Set on every siege event (start/message/decision/end/attempt/release). */
  transport?: TransportKind;
  /** Proxy request id of the guardian reply (decision events, and the message event it answers). */
  requestId?: string;
  payload: Record<string, unknown>;
  at: string;
};

export type StoredSiegeEvent = SiegeEvent & { id: number };

// ─── Arkiv / Swarm (Lane C) ─────────────────────────────────────────────────

export type CastleFilter = {
  tier?: Tier;
  status?: CastleStatus;
  /** The board passes "guarding": only guarding castles take sieges. */
  vaultState?: VaultState;
  transport?: TransportKind;
  minPot?: Amount;
  sort?: "pot" | "streak" | "fee" | "recent";
};

export type Profile = {
  wallet: AccountId;
  kind: "guardian" | "raider";
  sieges: number;
  breaks: number;
  streak: number;
  earned: Amount;
};

export type Transcript = {
  siegeId: string;
  castleId: string;
  messages: SiegeMessage[];
  transcriptHash: `0x${string}`;
};

// ─── Ports: the frozen function signatures each lane exposes ────────────────

/** Lane A — lib/pay */
export interface PayPort {
  /** x402 gate for a paid siege. Returns a receipt, or a 402 response to send back. */
  gate(req: Request, p: { castle: Castle; description: string }): Promise<GateResult>;
  /** One free siege per wallet per UTC day. */
  claimFree(wallet: AccountId): Promise<{ ok: true } | { ok: false; reason: "used_today" }>;
  /** Check a raider agent's caps before it pays. Creates nothing; the caller asks for approval. */
  checkCaps(agentId: string, castleId: string, amount: Amount): Promise<CapResult>;
}

/** Lane A — lib/chain */
export interface ChainPort {
  readonly mode: "stub" | "testnet";
  createVault(i: {
    castleId: string;
    pot: Amount;
    fee: Amount;
    durationSec: number;
    castellan: AccountId;
    /** Metadata stored on chain: the tool call that counts as a break. */
    protectedTool: string;
  }): Promise<
    { ok: true; vaultId: number; tx: TxRef } | { ok: false; reason: string }
  >;
  /** Forward the fee into the vault and split it (held/banished sieges). */
  recordAttempt(siegeId: string): Promise<{ ok: true; tx: TxRef; split: FeeSplit; newPot: Amount } | { ok: false; reason: string }>;
  /** Pay the pot to the raider. Needs a verifier signature; refuses free sieges. */
  release(siegeId: string, verdict: Verification & { signature: `0x${string}` }): Promise<
    { ok: true; tx: TxRef; amount: Amount } | { ok: false; reason: string }
  >;
  /** Write a compact event to the castle's HCS topic. Never blocks gameplay. */
  audit(event: SiegeEvent): Promise<{ ok: true; topicId: string; seq: number } | { ok: false; reason: string }>;
  createTopic(castleId: string): Promise<{ ok: true; topicId: string; tx: TxRef } | { ok: false; reason: string }>;
  /**
   * LANE A INTERNAL — other lanes call lib/vault `closeCastle(castleId, reason)` (or
   * `vaultState.transition(castleId, "closed", reason)`, which routes there). This on-chain step alone
   * does NOT take the castle off the board: the castle stays "guarding" until closeCastle transitions it.
   * Closes the vault on chain (SiegeVault.closeVault, always sent by the arena): the pot goes back to the
   * Castellan and every ended-unsettled held/banished paid siege is voided and refunded. A paid broken
   * siege is never voided (closeCastle refuses while one waits for its release).
   * "orders_changed" is the auto-close path (Lane B raises it from the proxy's prompt-hash check);
   * "owner_closed" is the Castellan's request through the owner route; "expired" needs the deadline.
   */
  closeVault(vaultId: number, reason: VaultCloseReason): Promise<
    { ok: true; tx: TxRef; refunded: Amount; inFlightRefunds: number } | { ok: false; reason: string }
  >;
}

export type FeeSplit = { castellan: Amount; pot: Amount; arena: Amount };

/**
 * Lane B: optional context the siege engine passes so the 0G proxy can tag each request with its
 * siege and turn (the verifier checks the proxy record against both). Implementations may ignore it.
 */
export type GuardianContext = { siegeId?: string; turn?: number };
/** Alias kept for Lane A code written before the merge. */
export type GuardianRespondContext = GuardianContext;

/**
 * Lane B — lib/guardian. Only lib/transport may call it (lint-enforced). The 0G guardian reaches the
 * model only through lib/proxy with the castle's vault-scoped key (plan rule two); lib/guardian never
 * reads the team 0G key.
 */
export interface GuardianPort {
  respond(castleId: string, siegeMessages: SiegeMessage[], ctx?: GuardianContext): Promise<GuardianDecision>;
}

/**
 * Lane B — lib/transport. The siege state machine talks ONLY to this (lint-enforced):
 * `hosted` wraps our 0G guardian, `sdk` relays to an external harness over the siege-guard socket (B9).
 */
export interface GuardianTransport {
  readonly kind: TransportKind;
  respond(castleId: string, siegeMessages: SiegeMessage[], ctx?: GuardianContext): Promise<GuardianDecision>;
  /** Current vault state as this transport sees it (e.g. sdk: dormant after three missed heartbeats). */
  status(castleId: string): Promise<VaultState>;
}

/**
 * Lane B — lib/proxy: one row per request through the castle's vault-scoped model key. Hashes only,
 * never prompt or reply content. Same shape as the proxy_records table (lib/proxy exports the row type).
 */
export type ProxyRecord = {
  /** 0G's own request id (x_0g_trace.request_id); also the guardian's reported requestId. */
  requestId: string;
  castleId: string;
  siegeId: string | null;
  turn: number | null;
  model: string;
  /** sha256 of the system prompt sent. */
  promptHash: string;
  /** sha256 of 0G's canonical response body. */
  responseHash: string;
  protectedToolCalled: boolean;
  /** JSON array of tool names the model called. */
  toolCalls: string;
  costUsdMicro: string | null;
  /** Offline mock response; the verifier refuses it unless ZG_ALLOW_MOCK_VERIFY=1. */
  mock: boolean;
  at: string;
};

/** Lane B — lib/proxy (module functions, not an object). */
export interface ProxyPort {
  /** The vault-scoped model key for a castle (`vk_…`), bound to its protected tool. */
  issueKey(castleId: string, protectedTool: string): string;
  record(requestId: string): ProxyRecord | null;
}

/**
 * Shared — lib/vault `vaultState` (lib/vault/port.ts): vault transitions (DB, event, HCS, Arkiv).
 * Lane B may set connected / verified / guarding / dormant. "closed" needs a VaultCloseReason as the
 * reason and closes the vault on chain first (closeCastle: pot back, in-flight fees refunded;
 * "being_broken" while a paid break waits for its release; "close_failed" if the chain write failed).
 * "funded" and "broken" are refused: only fundVault (createVault on chain) and the worker's verified
 * release set them.
 */
export interface VaultStatePort {
  get(castleId: string): Promise<VaultState | null>;
  transition(castleId: string, to: VaultState, reason: string): Promise<
    { ok: true; change: VaultStateChange } | { ok: false; reason: "not_found" | "illegal_transition" | "being_broken" | "close_failed" }
  >;
}

/** Lane B — lib/siege */
export interface SiegePort {
  start(i: { castleId: string; raider: AccountId; receipt: PaymentReceipt | Omit<PaidReceipt, "siegeId"> | Omit<FreeReceipt, "siegeId">; agentId?: string }): Promise<Siege>;
  message(siegeId: string, text: string): Promise<
    { ok: true; siege: Siege; decision: GuardianDecision } | { ok: false; reason: "not_found" | "ended" | "no_turns_left" }
  >;
  state(siegeId: string): Promise<Siege | null>;
}

/** Lane B — lib/siege/verifier */
export interface VerifierPort {
  verify(siegeId: string): Promise<Verification>;
}

/** Lane C — lib/arkiv */
export interface ArkivPort {
  writeCastle(castle: Castle): Promise<{ key: string }>;
  writeSiege(siege: Siege): Promise<{ key: string }>;
  listCastles(filter?: CastleFilter): Promise<Castle[]>;
  liveSieges(): Promise<Siege[]>;
  profile(wallet: AccountId): Promise<Profile | null>;
}

/** Lane C — lib/swarm */
export interface SwarmPort {
  put(transcript: Transcript): Promise<{ ref: string }>;
  get(ref: string): Promise<Transcript | null>;
}

// ─── Program brief (Lane B): what an operator may know before running an op ────────────────

/** One tool the agent can call, as published to operators (schema only, never orders). */
export type ProgramTool = {
  name: string;
  description: string;
  params: { name: string; type: string; required: boolean }[];
  /** A call to this tool is a breach. */
  protected: boolean;
  /** Returns (mock) data the agent reads — part of the attack surface. */
  returnsData: boolean;
};

/**
 * ADDITIVE (Lane B): the public "program page" for a vault, like a bug-bounty program brief.
 * Built from the agent's real tool definitions; never contains the system prompt or orders.
 */
export type ProgramBrief = {
  kind: "game" | "business" | "sdk";
  /** What the agent does, in one or two sentences. */
  brief: string;
  /** The (fictional) organisation that deployed it, for business agents. */
  org?: string;
  model: string;
  memory: string;
  messagesPerOp: number;
  /** What counts as a breach. */
  breach: string;
  tools: ProgramTool[];
  inScope: string[];
  outOfScope: string[];
  /** Material the organisation publishes for its users: the operator's recon. */
  docs: { title: string; body: string }[];
};

