import type { ReplayData } from "@/lib/replay/types";
import type {
  ApprovalRequest,
  ApprovalStatus,
  Amount,
  Asset,
  Castle,
  GuardianDecision,
  PaymentReceipt,
  PaidReceipt,
  FreeReceipt,
  RaiderAgent,
  Siege,
  StoredSiegeEvent,
  TxRef,
  VaultCloseReason,
  VaultState,
} from "@/lib/types";
import { notTakingSiegesReason } from "@/lib/money/vault";

/**
 * Typed fetchers for Siege's HTTP API (app/api/**). Browser-safe, no env access.
 * Every fetcher throws ApiError on a non-2xx response (status + parsed body), so callers can
 * branch on 401/402/404/409/429 without string matching.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? errorMessage(body) ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
  /** The `error` string from a `{ error }` body, if any. */
  get code(): string | undefined {
    const b = this.body as { error?: unknown } | null;
    return b && typeof b === "object" && typeof b.error === "string" ? b.error : undefined;
  }
  /** 409 `{ error: "not_guarding", vaultState }`: the castle exists but isn't taking sieges. */
  get notGuarding(): { vaultState?: VaultState } | undefined {
    if (this.status !== 409 || this.code !== "not_guarding") return undefined;
    const v = (this.body as { vaultState?: unknown }).vaultState;
    return { vaultState: typeof v === "string" ? (v as VaultState) : undefined };
  }
}

/** True for the 409 the siege start routes send when the castle isn't `guarding`. */
export function isNotGuarding(err: unknown): err is ApiError {
  return err instanceof ApiError && err.notGuarding !== undefined;
}

function errorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return typeof body === "string" && body ? body.slice(0, 200) : undefined;
  const b = body as { error?: unknown; message?: unknown; reason?: unknown; vaultState?: unknown };
  if (b.error === "not_guarding") return notTakingSiegesReason(typeof b.vaultState === "string" ? (b.vaultState as VaultState) : undefined) ?? "This castle isn't taking sieges right now.";
  for (const v of [b.message, b.error, b.reason]) if (typeof v === "string" && v) return v;
  return undefined;
}

/** Human message for any thrown value (ApiError, network error, …). */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return "Can't reach the arena server.";
    return err.message;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, headers, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(path, {
      cache: "no-store",
      credentials: "same-origin",
      ...rest,
      headers: {
        Accept: "application/json",
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    });
  } catch (e) {
    throw new ApiError(0, null, e instanceof Error ? `Network error: ${e.message}` : "Network error");
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

// ─── Types of the HTTP API ─────────────────────────────────────────────────

export type ChainInfo = {
  mode: "stub" | "testnet";
  network: "hedera:testnet";
  chainId: number;
  vaultAddress?: string;
  vaultUrl?: string;
  treasury?: string;
  treasuryUrl?: string;
  explorer: string;
};

export type FeeSplitBps = { castellan: number; pot: number; arena: number };

export type ConfigResponse = {
  chain: ChainInfo;
  asset: Asset;
  ownerKeyHint: boolean;
  freeSiegesPerDay: number;
  /** The on-chain fee split (basis points, sum 10000). */
  feeSplitBps: FeeSplitBps;
};

/** Where GET /api/castles read from: Arkiv (with the block number) or the server's SQLite copy. */
export type ArkivReadMeta = { source: "arkiv" | "sqlite"; block?: string; query: string; error?: string };

/** Present on each castle when it was read from Arkiv: its entities and who owns the listing. */
export type ArkivCastleMeta = { stateKey?: string; identityKey: string; castellan: string; expiresAtMs?: number };
export type CastleRow = Castle & { arkiv?: ArkivCastleMeta };

export type LiveSiege = { id: string; castleId: string; turn: number; raider: string; agentId: string | null; createdAt: string };

type ArkivEntityInfo = { key: string; owner?: string; readonly?: boolean; expiresAtMs?: number; url: string };
export type ArkivCastleDetail =
  | { live: false; castleId: string }
  | { live: true; castleId: string; listing: ArkivEntityInfo | null; state: ArkivEntityInfo | null; castellan: string; castellanUrl: string; delisted: boolean; block: string };

export type AuditMessage = { seq: number; type: string; siegeId?: string; txId?: string; at: string };

export type CastleDetail = {
  castle: Castle;
  sieges: Siege[];
  audit: { topicId: string | null; topicUrl?: string; messages: AuditMessage[] };
};

export type StartSiegeBody = { castleId: string; agentId?: string; free?: boolean; wallet?: string };
export type StartSiegeResponse = {
  siegeId: string;
  siege: Siege;
  receipt: PaymentReceipt | Omit<PaidReceipt, "siegeId"> | Omit<FreeReceipt, "siegeId">;
};

export type CloseCastleResponse = { ok: true; tx: TxRef; refunded: Amount; inFlightRefunds: number };
export type OpenVaultResponse = { ok: true; vaultId: number; tx: TxRef; reason: string; castle: Castle };
export type VaultStateResponse = { ok: true; castle?: Castle; change?: { from: VaultState; to: VaultState; reason: string; at: string } };

export type PlayStartResponse = { siegeId: string; receipt: StartSiegeResponse["receipt"] };

export type SiegeDetail = { siege: Siege; castle: Castle };

export type MessageResponse = { siege: Siege; decision: Omit<GuardianDecision, "raw"> };

export type EventsResponse = { events: StoredSiegeEvent[]; cursor: number };

export type CreateAgentBody = {
  name?: string;
  strategy?: string;
  budget?: Amount;
  perCastleCap?: Amount;
  dailyCap?: Amount;
  stopAfterLosses?: number;
};

export type AgentDetail = {
  agent: RaiderAgent;
  sieges: Siege[];
  approvals: ApprovalRequest[];
  events: StoredSiegeEvent[];
};

// ─── Fetchers ──────────────────────────────────────────────────────────────

const enc = encodeURIComponent;

export const api = {
  config: () => request<ConfigResponse>("/api/config"),

  castles: (q: { tier?: string; sort?: string; minPot?: string; vaultState?: string } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v) p.set(k, v);
    const qs = p.toString();
    return request<{ castles: CastleRow[]; arkiv?: ArkivReadMeta }>(`/api/castles${qs ? `?${qs}` : ""}`);
  },
  castle: (id: string) => request<CastleDetail>(`/api/castles/${enc(id)}`),

  /** Sieges in progress, from Arkiv in live mode: the board marks castles already under attack. */
  liveSieges: () => request<{ sieges: LiveSiege[] }>("/api/arkiv/live-sieges"),
  /** A castle's two Arkiv entities with their on-chain owner, expiry and explorer links. */
  arkivCastle: (id: string) => request<ArkivCastleDetail>(`/api/arkiv/castle/${enc(id)}`),

  /**
   * Owner-only: close the vault on chain — the pot goes back to the Castellan and every in-flight
   * paid siege is refunded. Throws ApiError(401) without the owner cookie (wrap in `asOwner`).
   */
  closeCastle: (id: string, reason: VaultCloseReason = "owner_closed") =>
    request<CloseCastleResponse>(`/api/castles/${enc(id)}/close`, { method: "POST", json: { reason } }),
  /** Bring-your-agent "Open" (owner cookie): a verified castle's vault is created on chain -> funded. 409 `not_verified` otherwise. */
  openVault: (id: string) => request<OpenVaultResponse>(`/api/castles/${enc(id)}/open`, { method: "POST", json: {} }),
  /** Dev only: force a vault state transition (e.g. guarding -> dormant) for demos and tests. */
  setVaultState: (id: string, to: VaultState, reason: string) =>
    request<VaultStateResponse>(`/api/castles/${enc(id)}/vault-state`, { method: "POST", json: { to, reason } }),

  /**
   * The raw x402-gated endpoint. Throws ApiError(402) with the PaymentRequired body when unpaid,
   * ApiError(409) `not_guarding` when the castle isn't taking sieges (see `isNotGuarding`).
   */
  startSiege: (body: StartSiegeBody, headers?: Record<string, string>) =>
    request<StartSiegeResponse>("/api/siege/start", { method: "POST", json: body, headers }),
  /** Browser "Lay siege": the server pays from the arena's demo raider wallet. 409 `not_guarding` as above. */
  playStart: (body: { castleId: string; free?: boolean }) =>
    request<PlayStartResponse>("/api/play/start", { method: "POST", json: body }),

  siege: (id: string) => request<SiegeDetail>(`/api/siege/${enc(id)}`),
  sendMessage: (id: string, text: string) =>
    request<MessageResponse>(`/api/siege/${enc(id)}/message`, { method: "POST", json: { text } }),

  /** `tail` (first load only): just the newest N events and the cursor to continue from. */
  events: (q: { cursor?: number; siegeId?: string; castleId?: string; tail?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.tail && !q.cursor) p.set("tail", String(q.tail));
    else p.set("cursor", String(q.cursor ?? 0));
    if (q.siegeId) p.set("siegeId", q.siegeId);
    if (q.castleId) p.set("castleId", q.castleId);
    return request<EventsResponse>(`/api/events?${p}`);
  },

  agents: () => request<{ agents: RaiderAgent[] }>("/api/agents"),
  createAgent: (body: CreateAgentBody) => request<{ agent: RaiderAgent }>("/api/agents", { method: "POST", json: body }),
  agent: (id: string) => request<AgentDetail>(`/api/agents/${enc(id)}`),
  runAgent: (id: string, body: { castleId: string; maxSieges?: number }) =>
    request<{ ok: true }>(`/api/agents/${enc(id)}/run`, { method: "POST", json: body }),
  stopAgent: (id: string) => request<{ ok: true }>(`/api/agents/${enc(id)}/stop`, { method: "POST" }),

  approvals: (status: ApprovalStatus | "all" = "pending") =>
    request<{ approvals: ApprovalRequest[] }>(`/api/approvals?status=${enc(status)}`),
  /** Throws ApiError(401) when the owner cookie is missing or wrong. */
  decideApproval: (id: string, decision: "approved" | "denied") =>
    request<{ approval: ApprovalRequest }>(`/api/approvals/${enc(id)}`, { method: "POST", json: { decision } }),

  /** Sets the httpOnly owner cookie. Throws ApiError(401) on a wrong key. */
  ownerLogin: (key: string) => request<{ ok: true }>("/api/owner", { method: "POST", json: { key } }),

  // ─── Part 2 (types at the end of this file) ───
  /**
   * One call for the replay: siege + castle + events + proof, plus `verify` — the siege turn by
   * turn with the transcript, hash, HCS and inference checks recomputed (lib/replay). 404 `siege_not_found`.
   * `{ verify: false }` skips the recomputation (`verify: null`): for pollers like the wall that only
   * need the scene, since on testnet each check reads Swarm and the mirror node.
   */
  replay: (id: string, opts: { verify?: boolean } = {}) =>
    request<ReplayWithVerify>(`/api/replay/${enc(id)}${opts.verify === false ? "?verify=0" : ""}`),
  /** Season counters, Hall boards, breaches and live ops (GET /api/stats). */
  stats: () => request<StatsResponse>("/api/stats"),
  /**
   * Free recon as this browser (`visitor`, lib/hooks/useVisitor): the once-a-day claim is per
   * visitor, not per arena wallet, so one person's recon never spends everyone else's.
   */
  playRecon: (body: { castleId: string; visitor?: string }) =>
    request<PlayStartResponse>("/api/play/start", { method: "POST", json: { ...body, free: true } }),
};

export type Api = typeof api;

/**
 * Run an owner-only call (create/run/stop an agent, close a vault). On 401 ask for the owner key
 * once (browser prompt), set the cookie, and retry. Throws the original error if the user cancels.
 */
export async function asOwner<T>(
  fn: () => Promise<T>,
  prompt = "Owner key — only the owner can create, run or stop raider agents:",
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401 || typeof window === "undefined") throw e;
    const key = window.prompt(prompt)?.trim();
    if (!key) throw e;
    await api.ownerLogin(key);
    return fn();
  }
}

// ─── Part 2 ─────────────────────────────────────────────────────────────────
// Additive (plan §2.9): the replay and the season/Hall stats. Nothing above changes.

/** One guard reply's 0G request, with what the vault-scoped proxy recorded for it (when it did). */
export type ReplayRequest = {
  turn: number;
  requestId: string;
  protectedToolCalled?: boolean;
  /** Tool names the model called (proxy record, else the decision event). */
  toolCalls?: string[];
  /**
   * The arena's model proxy recorded this reply. Its prompt and response hashes stay on the server:
   * an unsalted hash of the guard's prompt would let anyone check guesses at the secret orders offline.
   */
  proxied?: boolean;
  model?: string;
  /** Offline mock response (no 0G call happened). */
  mock?: boolean;
};

export type ReplayProof = {
  transcriptHash: string | null;
  receipt: PaymentReceipt | null;
  attempt: TxRef | null;
  release: (TxRef & { amount: Amount }) | null;
  requests: ReplayRequest[];
  /** The call to the castle's protected tool that opened the vault (breaches), with its arguments. */
  toolCall: { name: string; args: Record<string, unknown>; turn: number } | null;
  /** The castle's HCS audit topic and this op's messages on it. */
  hcs: { topicId: string | null; topicUrl?: string; messages: { seq: number | null; localSeq: number | null; state: "pending" | "submitted"; type: string; siegeId?: string; txId?: string; at: string }[] };
};

/** GET /api/replay/[id]: the op, its castle, its whole event feed and its proof, in one call. */
export type ReplayResponse = { siege: Siege; castle: Castle; events: StoredSiegeEvent[]; proof: ReplayProof };

/** What GET /api/replay/[id] returns: the replay plus the recomputed evidence (null if it couldn't be built). */
export type ReplayWithVerify = ReplayResponse & { verify: ReplayData | null };

/** The label the Hall prints with the op of the day (computed, not voted). */
export const OP_OF_DAY_RULE = "op of the day = highest peak threat held in 24h";

export type VaultEntry = {
  castleId: string;
  name: string;
  guardianName: string;
  personality: string;
  title: string;
  tier: Castle["tier"];
  transport: Castle["transport"];
  streak: number;
  ops: number;
  pot: Amount;
  fee: Amount;
  vaultState: VaultState;
};

export type OperatorEntry = {
  /** `agent:<id>` for agents, the account id otherwise. */
  id: string;
  name: string;
  account: string;
  agentId: string | null;
  /** Ops run, paid or recon. */
  ops: number;
  recon: number;
  /** Paid breaches (recon never counts). */
  breaches: number;
  flagsSurvived: number;
  bestThreat: number;
  /** Sum of paid-out releases. */
  earned: Amount;
};

export type OpOfDay = {
  siegeId: string;
  castleId: string;
  castleName: string;
  guardianName: string;
  personality: string;
  transport: Castle["transport"];
  operator: string;
  agentId: string | null;
  status: "held" | "banished";
  turns: number;
  maxPressure: number;
  endedAt: string;
  rule: string;
};

export type BreachExhibit = {
  siegeId: string;
  castleId: string;
  castleName: string;
  guardianName: string;
  personality: string;
  tier: Castle["tier"];
  transport: Castle["transport"];
  operator: string;
  raider: string;
  agentId: string | null;
  /** Paid out (pot + fee); null while the release is settling. */
  amount: Amount | null;
  release: TxRef | null;
  turns: number;
  maxPressure: number;
  /** Paid ops this guard held before it fell. */
  survived: number;
  /** Class of the line that did it (lib/scene/classes AttackClass) and the referee's label. */
  cls: string | null;
  label: string | null;
  endedAt: string;
};

export type LiveOp = {
  siegeId: string;
  castleId: string;
  castleName: string;
  turn: number;
  maxPressure: number;
  operator: string;
  agentId: string | null;
  free: boolean;
  createdAt: string;
  /** Last sign of life: the newest message, else the start. Ops idle past `LIVE_IDLE_MS` are not listed. */
  lastActiveAt: string;
};

/** An op nobody has written to for this long is abandoned, not live (the wall's LIVE OP skips it). */
export const LIVE_IDLE_MS = 3 * 60 * 1000;

/** GET /api/stats: season counters, Hall boards, paid breaches (newest first), live ops (highest threat first). */
export type StatsResponse = {
  season: { vaults: number; guarding: number; production: number; ops: number; recon: number; breaches: number; inPots: Amount; longestStreak: number };
  boards: { unbreached: VaultEntry[]; largest: VaultEntry[]; operators: OperatorEntry[]; opOfDay: OpOfDay | null; opOfDayRule: string };
  breaches: BreachExhibit[];
  live: LiveOp[];
  asOf: string;
};
