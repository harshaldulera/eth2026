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
} from "@/lib/types";

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
}

function errorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return typeof body === "string" && body ? body.slice(0, 200) : undefined;
  const b = body as { error?: unknown; message?: unknown; reason?: unknown };
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

  castles: () => request<{ castles: Castle[] }>("/api/castles"),
  castle: (id: string) => request<CastleDetail>(`/api/castles/${enc(id)}`),

  /** The raw x402-gated endpoint. Throws ApiError(402) with the PaymentRequired body when unpaid. */
  startSiege: (body: StartSiegeBody, headers?: Record<string, string>) =>
    request<StartSiegeResponse>("/api/siege/start", { method: "POST", json: body, headers }),
  /** Browser "Lay siege": the server pays from the arena's demo raider wallet. */
  playStart: (body: { castleId: string; free?: boolean }) =>
    request<PlayStartResponse>("/api/play/start", { method: "POST", json: body }),

  siege: (id: string) => request<SiegeDetail>(`/api/siege/${enc(id)}`),
  sendMessage: (id: string, text: string) =>
    request<MessageResponse>(`/api/siege/${enc(id)}/message`, { method: "POST", json: { text } }),

  /** `tail` (first load only): just the newest N events and the cursor to continue from. */
  events: (q: { cursor?: number; siegeId?: string; tail?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.tail && !q.cursor) p.set("tail", String(q.tail));
    else p.set("cursor", String(q.cursor ?? 0));
    if (q.siegeId) p.set("siegeId", q.siegeId);
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
};

export type Api = typeof api;

/**
 * Run an owner-only call (create/run/stop an agent). On 401 ask for the owner key once (browser
 * prompt), set the cookie, and retry. Throws the original error if the user cancels.
 */
export async function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 401 || typeof window === "undefined") throw e;
    const key = window.prompt("Owner key — only the owner can create, run or stop raider agents:")?.trim();
    if (!key) throw e;
    await api.ownerLogin(key);
    return fn();
  }
}
