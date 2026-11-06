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

/** How a guardian is reached: our hosted runtime, or an external harness through the @siege/guard SDK. */
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
  /** Only an `open_vault` call means the vault opens. */
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

export type CapReason = "per_castle" | "daily" | "budget" | "stop_rule" | "stopped";

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
   * Close a vault: returns the pot to the Castellan on chain and refunds every in-flight paid siege.
   * "orders_changed" is the auto-close path (Lane B raises it from the proxy's prompt-hash check);
   * "owner_closed" is the Castellan's choice; "expired" needs the deadline to have passed.
   */
  closeVault(vaultId: number, reason: VaultCloseReason): Promise<
    { ok: true; tx: TxRef; refunded: Amount; inFlightRefunds: number } | { ok: false; reason: string }
  >;
}

export type FeeSplit = { castellan: Amount; pot: Amount; arena: Amount };

/** Lane B — lib/guardian */
export interface GuardianPort {
  respond(castleId: string, siegeMessages: SiegeMessage[]): Promise<GuardianDecision>;
}

/**
 * Lane B — lib/transport. The siege state machine talks ONLY to this (lint-enforced):
 * `hosted` wraps our 0G guardian, `sdk` relays to an external harness over the @siege/guard socket.
 */
/** Where a guardian reply is asked for: the proxy tags its request record with these (turn defaults to the last raider turn). */
export type GuardianRespondContext = { siegeId?: string; turn?: number };

export interface GuardianTransport {
  readonly kind: TransportKind;
  respond(castleId: string, siegeMessages: SiegeMessage[], ctx?: GuardianRespondContext): Promise<GuardianDecision>;
  /** Current vault state as this transport sees it (e.g. sdk: dormant after three missed heartbeats). */
  status(castleId: string): Promise<VaultState>;
}

/** Lane B — lib/proxy: one record per inference request through the vault-scoped model key. Hashes only, never content. */
export type ProxyRecord = {
  requestId: string;
  vaultId: string;
  siegeId?: string;
  turn?: number;
  promptHash: `0x${string}`;
  protectedToolCalled: boolean;
  at: string;
};

export interface ProxyPort {
  issueKey(vaultId: string): Promise<{ modelKey: string; baseURL: string }>;
  record(requestId: string): Promise<ProxyRecord | null>;
}

/** Shared — lib/vault/state: the one place vault transitions happen (DB, event, HCS, Arkiv). */
export interface VaultStatePort {
  get(castleId: string): Promise<VaultState | null>;
  transition(castleId: string, to: VaultState, reason: string): Promise<
    { ok: true; change: VaultStateChange } | { ok: false; reason: "not_found" | "illegal_transition" }
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
