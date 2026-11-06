/**
 * The app's types <-> Arkiv entity values. Pure functions, no network.
 *
 * The app's data model keeps its original names (Castle, Siege, Castellan, Raider); Arkiv speaks the
 * game's vocabulary (lib/vocab): vault, op, owner, operator, breach, lockdown, offline, recon, tiers
 * 1–3. Every mapping lives here, in both directions.
 */
import { bool, str, u64 } from "@arkiv-network/sdk/schema";
import { assetFor, titleFor } from "@/lib/castles";
import type { Castle, CastleStatus, Profile, Siege, SiegeStatus, Tier, TransportKind, VaultState } from "@/lib/types";

/** Value object as returned by a query row ({ type, value }). */
type Cell = { value: unknown } | undefined;
export type Row = Record<string, unknown>;

const cell = (r: Row, k: string) => (r[k] as Cell)?.value;
const s = (r: Row, k: string) => {
  const v = cell(r, k);
  return v === undefined || v === null ? undefined : String(v);
};
const n = (r: Row, k: string) => {
  const v = cell(r, k);
  return v === undefined || v === null ? undefined : Number(v as bigint);
};
const big = (v: string | number) => {
  const b = BigInt(v);
  return b < BigInt(0) ? BigInt(0) : b;
};
const ms = (iso: string | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : 0;
};
const invert = <K extends string, V extends string>(m: Record<K, V>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k])) as Record<V, K>;

// ─── Vocabulary: app values -> Arkiv values ─────────────────────────────────

export const TIER_NUMBER: Record<Tier, number> = { wooden: 1, stone: 2, iron: 3 };
const TIER_OF = Object.fromEntries(Object.entries(TIER_NUMBER).map(([k, v]) => [v, k])) as Record<number, Tier>;

/** An op's status on Arkiv, in the game's words (HELD · BREACHED · LOCKDOWN). */
export const OP_STATUS: Record<SiegeStatus, string> = { created: "created", in_progress: "live", held: "held", broken: "breached", banished: "lockdown" };
const SIEGE_STATUS_OF = invert(OP_STATUS);

/** A vault's outcome on Arkiv. */
export const VAULT_OUTCOME: Record<CastleStatus, string> = { open: "open", broken: "breached", closed: "closed" };
const CASTLE_STATUS_OF = invert(VAULT_OUTCOME);

/** A vault's lifecycle state on Arkiv (the LEDs: GUARDING · OFFLINE · BREACHED · CLOSED). */
export const VAULT_LIFECYCLE: Record<VaultState, string> = {
  created: "created",
  connected: "connected",
  verified: "verified",
  funded: "funded",
  guarding: "guarding",
  dormant: "offline",
  broken: "breached",
  closed: "closed",
};
const VAULT_STATE_OF = invert(VAULT_LIFECYCLE);

/** What a vault read from Arkiv carries beyond the shared Castle type. */
export type VaultArkivMeta = {
  /** Key of the arena-owned `vaultStatus` entity the board read. */
  statusKey?: string;
  /** Key of the Owner-owned `vault` entity (the listing they can delete). */
  listingKey: string;
  /** EVM address that owns the listing. */
  ownerWallet: string;
  /** When the status entity expires, unix ms (estimated from the block it was read at). */
  expiresAtMs?: number;
};

export type CastleOnArkiv = Castle & { arkiv: VaultArkivMeta };

// ─── Vault ─────────────────────────────────────────────────────────────────

/** The listing: fixed at creation, owned by the vault's Owner. */
export function vaultListingValues(c: Castle) {
  return {
    vaultId: str(c.id),
    name: str(c.name),
    guardName: str(c.guardianName),
    voice: str(c.personality),
    tier: u64(TIER_NUMBER[c.tier] ?? 1),
    transport: str(c.transport),
    protectedAction: str(c.protectedTool),
    ownerAccount: str(c.owner),
    assetId: str(c.asset.id),
    deadline: u64(big(c.deadline)),
    createdAtMs: u64(big(ms(c.createdAt))),
    ...(c.portraitUrl ? { portraitUrl: str(c.portraitUrl) } : {}),
  };
}

/** Everything that moves, plus the listing fields again so The Grid reads one entity. */
export function vaultStatusValues(c: Castle, link: { ownerWallet: string; listingKey: string }) {
  return {
    ...vaultListingValues(c),
    listingKey: str(link.listingKey),
    ownerWallet: str(link.ownerWallet),
    status: str(VAULT_OUTCOME[c.status] ?? c.status),
    pot: u64(big(c.pot)),
    fee: u64(big(c.fee)),
    streak: u64(big(c.streak)),
    opCount: u64(big(c.siegeCount)),
    vaultState: str(VAULT_LIFECYCLE[c.vaultState] ?? c.vaultState),
    ...(c.vaultStateReason ? { vaultStateReason: str(c.vaultStateReason) } : {}),
    ...(c.lastSeenAt ? { lastSeenAtMs: u64(big(ms(c.lastSeenAt))) } : {}),
    ...(c.vaultId !== null && c.vaultId !== undefined ? { contractVaultId: u64(big(c.vaultId)) } : {}),
    ...(c.topicId ? { topicId: str(c.topicId) } : {}),
  };
}

/** A vault from a `vaultStatus` row. `$key` / `$expiresAt` are read when the query selected them. */
export function rowToCastle(r: Row): CastleOnArkiv {
  const streak = n(r, "streak") ?? 0;
  const status = s(r, "status");
  const state = s(r, "vaultState");
  const c: CastleOnArkiv = {
    id: s(r, "vaultId") ?? "",
    name: s(r, "name") ?? "",
    guardianName: s(r, "guardName") ?? "",
    title: titleFor(streak),
    personality: s(r, "voice") ?? "stern",
    tier: TIER_OF[n(r, "tier") ?? 1] ?? "wooden",
    pot: s(r, "pot") ?? "0",
    fee: s(r, "fee") ?? "0",
    asset: assetFor(s(r, "assetId") ?? "0.0.0"),
    streak,
    siegeCount: n(r, "opCount") ?? 0,
    status: (status && CASTLE_STATUS_OF[status]) || "open",
    owner: s(r, "ownerAccount") ?? "",
    vaultId: n(r, "contractVaultId") ?? null,
    topicId: s(r, "topicId") ?? null,
    deadline: n(r, "deadline") ?? 0,
    createdAt: new Date(n(r, "createdAtMs") ?? 0).toISOString(),
    vaultState: (state && VAULT_STATE_OF[state]) || "guarding",
    transport: (s(r, "transport") ?? "hosted") as TransportKind,
    protectedTool: s(r, "protectedAction") ?? "",
    arkiv: {
      listingKey: s(r, "listingKey") ?? "",
      ownerWallet: s(r, "ownerWallet") ?? "",
      ...(typeof r.$key === "string" ? { statusKey: r.$key } : {}),
    },
  };
  const reason = s(r, "vaultStateReason");
  if (reason) c.vaultStateReason = reason;
  const seen = n(r, "lastSeenAtMs");
  if (seen) c.lastSeenAt = new Date(seen).toISOString();
  const portrait = s(r, "portraitUrl");
  if (portrait) c.portraitUrl = portrait;
  return c;
}

// ─── Op ────────────────────────────────────────────────────────────────────

export function opValues(x: Siege, swarmRef?: string) {
  return {
    opId: str(x.id),
    vaultId: str(x.castleId),
    status: str(OP_STATUS[x.status] ?? x.status),
    turn: u64(big(x.turn)),
    operator: str(x.raider),
    transport: str(x.transport),
    recon: bool(x.free),
    startedAtMs: u64(big(ms(x.createdAt))),
    ...(x.agentId ? { agentId: str(x.agentId) } : {}),
    ...(x.transcriptHash ? { transcriptHash: str(x.transcriptHash) } : {}),
    ...(swarmRef ? { swarmRef: str(swarmRef) } : {}),
    ...(x.endedAt ? { endedAtMs: u64(big(ms(x.endedAt))) } : {}),
  };
}

/** An op as Arkiv knows it: no messages (those live in the transcript on Swarm). */
export function rowToSiege(r: Row): Siege & { swarmRef?: string } {
  const status = s(r, "status");
  const out: Siege & { swarmRef?: string } = {
    id: s(r, "opId") ?? "",
    castleId: s(r, "vaultId") ?? "",
    raider: s(r, "operator") ?? "",
    turn: n(r, "turn") ?? 0,
    status: (status && SIEGE_STATUS_OF[status]) || "created",
    transport: (s(r, "transport") ?? "hosted") as TransportKind,
    messages: [],
    free: Boolean(cell(r, "recon")),
    createdAt: new Date(n(r, "startedAtMs") ?? 0).toISOString(),
  };
  const agentId = s(r, "agentId");
  if (agentId) out.agentId = agentId;
  const th = s(r, "transcriptHash");
  if (th) out.transcriptHash = th as `0x${string}`;
  const ended = n(r, "endedAtMs");
  if (ended) out.endedAt = new Date(ended).toISOString();
  const ref = s(r, "swarmRef");
  if (ref) out.swarmRef = ref;
  return out;
}

// ─── Profiles ──────────────────────────────────────────────────────────────

export function profileValues(p: Profile) {
  return {
    wallet: str(p.wallet),
    ops: u64(big(p.sieges)),
    breaches: u64(big(p.breaks)),
    streak: u64(big(p.streak)),
    earned: u64(big(p.earned)),
  };
}

export function rowToProfile(r: Row, kind: Profile["kind"]): Profile {
  return {
    wallet: s(r, "wallet") ?? "",
    kind,
    sieges: n(r, "ops") ?? 0,
    breaks: n(r, "breaches") ?? 0,
    streak: n(r, "streak") ?? 0,
    earned: s(r, "earned") ?? "0",
  };
}

/** Stable fingerprint of entity values, to skip writes that change nothing. */
export function fingerprint(values: Record<string, { type: string; value: unknown }>): string {
  return JSON.stringify(
    Object.keys(values)
      .sort()
      .map((k) => [k, values[k].type, String(values[k].value)]),
  );
}
