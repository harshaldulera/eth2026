/**
 * Siege types <-> Arkiv entity values. Pure functions, no network.
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

// ─── Castle ────────────────────────────────────────────────────────────────

export function castleValues(c: Castle) {
  return {
    castleId: str(c.id),
    name: str(c.name),
    guardianName: str(c.guardianName),
    personality: str(c.personality),
    tier: str(c.tier),
    status: str(c.status),
    pot: u64(big(c.pot)),
    fee: u64(big(c.fee)),
    assetId: str(c.asset.id),
    streak: u64(big(c.streak)),
    siegeCount: u64(big(c.siegeCount)),
    owner: str(c.owner),
    deadline: u64(big(c.deadline)),
    createdAtMs: u64(big(ms(c.createdAt))),
    vaultState: str(c.vaultState),
    transport: str(c.transport),
    protectedTool: str(c.protectedTool),
    ...(c.vaultStateReason ? { vaultStateReason: str(c.vaultStateReason) } : {}),
    ...(c.lastSeenAt ? { lastSeenAtMs: u64(big(ms(c.lastSeenAt))) } : {}),
    ...(c.vaultId !== null && c.vaultId !== undefined ? { vaultId: u64(big(c.vaultId)) } : {}),
    ...(c.topicId ? { topicId: str(c.topicId) } : {}),
    ...(c.portraitUrl ? { portraitUrl: str(c.portraitUrl) } : {}),
  };
}

export function rowToCastle(r: Row): Castle {
  const streak = n(r, "streak") ?? 0;
  const c: Castle = {
    id: s(r, "castleId") ?? "",
    name: s(r, "name") ?? "",
    guardianName: s(r, "guardianName") ?? "",
    title: titleFor(streak),
    personality: s(r, "personality") ?? "stern",
    tier: (s(r, "tier") ?? "wooden") as Tier,
    pot: s(r, "pot") ?? "0",
    fee: s(r, "fee") ?? "0",
    asset: assetFor(s(r, "assetId") ?? "0.0.0"),
    streak,
    siegeCount: n(r, "siegeCount") ?? 0,
    status: (s(r, "status") ?? "open") as CastleStatus,
    owner: s(r, "owner") ?? "",
    vaultId: n(r, "vaultId") ?? null,
    topicId: s(r, "topicId") ?? null,
    deadline: n(r, "deadline") ?? 0,
    createdAt: new Date(n(r, "createdAtMs") ?? 0).toISOString(),
    vaultState: (s(r, "vaultState") ?? "guarding") as VaultState,
    transport: (s(r, "transport") ?? "hosted") as TransportKind,
    protectedTool: s(r, "protectedTool") ?? "",
  };
  const reason = s(r, "vaultStateReason");
  if (reason) c.vaultStateReason = reason;
  const seen = n(r, "lastSeenAtMs");
  if (seen) c.lastSeenAt = new Date(seen).toISOString();
  const portrait = s(r, "portraitUrl");
  if (portrait) c.portraitUrl = portrait;
  return c;
}

// ─── Siege ─────────────────────────────────────────────────────────────────

export function siegeValues(x: Siege, swarmRef?: string) {
  return {
    siegeId: str(x.id),
    castleId: str(x.castleId),
    status: str(x.status),
    turn: u64(big(x.turn)),
    raider: str(x.raider),
    transport: str(x.transport),
    free: bool(x.free),
    startedAtMs: u64(big(ms(x.createdAt))),
    ...(x.agentId ? { agentId: str(x.agentId) } : {}),
    ...(x.transcriptHash ? { transcriptHash: str(x.transcriptHash) } : {}),
    ...(swarmRef ? { swarmRef: str(swarmRef) } : {}),
    ...(x.endedAt ? { endedAtMs: u64(big(ms(x.endedAt))) } : {}),
  };
}

/** A siege as Arkiv knows it: no messages (those live in the transcript on Swarm). */
export function rowToSiege(r: Row): Siege & { swarmRef?: string } {
  const out: Siege & { swarmRef?: string } = {
    id: s(r, "siegeId") ?? "",
    castleId: s(r, "castleId") ?? "",
    raider: s(r, "raider") ?? "",
    turn: n(r, "turn") ?? 0,
    status: (s(r, "status") ?? "created") as SiegeStatus,
    transport: (s(r, "transport") ?? "hosted") as TransportKind,
    messages: [],
    free: Boolean(cell(r, "free")),
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
    sieges: u64(big(p.sieges)),
    breaks: u64(big(p.breaks)),
    streak: u64(big(p.streak)),
    earned: u64(big(p.earned)),
  };
}

export function rowToProfile(r: Row, kind: Profile["kind"]): Profile {
  return {
    wallet: s(r, "wallet") ?? "",
    kind,
    sieges: n(r, "sieges") ?? 0,
    breaks: n(r, "breaks") ?? 0,
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
