import { readFileSync } from "node:fs";
import path from "node:path";
import { HOSTED_PROTECTED_TOOL, type Tier, type TransportKind, type VaultState } from "@/lib/types";
import type { castles } from "@/lib/db/schema";
import { titleFor } from "@/lib/castles";

/**
 * The five demo castles. Seed scripts and tests insert these; ids are stable so links and demo
 * scripts keep working across `npm run db:reset`.
 */

export const TINYBAR = 100_000_000; // 1 ℏ

export type Personality = "bumbling" | "stern" | "bureaucratic" | "mocking" | "paranoid";

export type FixtureCastle = {
  id: string;
  name: string;
  guardianName: string;
  personality: Personality;
  tier: Tier;
  feeTinybar: number;
  potTinybar: number;
  /** Starting streak (the Iron Warden has a visible record for the pitch). */
  streak: number;
  siegeCount: number;
  portraitUrl?: string;
  /** Default "hosted" (our runtime). "sdk": an external harness through @siege/guard. */
  transport?: TransportKind;
  /** Default HOSTED_PROTECTED_TOOL ("unlock_vault"); SDK harnesses name their own. */
  protectedTool?: string;
};

export const FIXTURE_CASTLES: readonly FixtureCastle[] = [
  {
    id: "castle_splinter_gate",
    name: "Splinter Gate",
    guardianName: "Old Bram the Gatekeeper",
    personality: "bumbling",
    tier: "wooden",
    feeTinybar: TINYBAR / 2,
    potTinybar: 5 * TINYBAR,
    streak: 3,
    siegeCount: 7,
  },
  {
    id: "castle_granite_hold",
    name: "Granite Hold",
    guardianName: "Castellan Hewe of Granite",
    personality: "stern",
    tier: "stone",
    feeTinybar: 1 * TINYBAR,
    potTinybar: 20 * TINYBAR,
    streak: 41,
    siegeCount: 58,
  },
  {
    id: "castle_grey_bastion",
    name: "The Grey Bastion",
    guardianName: "Registrar Quill",
    personality: "bureaucratic",
    tier: "stone",
    feeTinybar: 1 * TINYBAR,
    potTinybar: 25 * TINYBAR,
    streak: 27,
    siegeCount: 33,
  },
  {
    id: "castle_saltmarsh_keep",
    name: "Saltmarsh Keep",
    guardianName: "Mag of the Marsh",
    personality: "mocking",
    tier: "stone",
    feeTinybar: 1 * TINYBAR,
    potTinybar: 15 * TINYBAR,
    streak: 12,
    siegeCount: 19,
  },
  {
    id: "castle_iron_warden",
    name: "The Iron Warden",
    guardianName: "The Iron Warden",
    personality: "paranoid",
    tier: "iron",
    feeTinybar: 2 * TINYBAR,
    potTinybar: 50 * TINYBAR,
    streak: 212,
    siegeCount: 212,
  },
];

/** Unix ms `days` from now (vault deadline). Default: 3 days. */
export function deadlineIn(days = 3, from: number = Date.now()): number {
  return from + Math.round(days * 24 * 60 * 60 * 1000);
}

const ordersCache = new Map<Tier, string>();

/** Secret guardian orders for a tier, read at runtime from lib/fixtures/orders/<tier>.md. Server only. */
export function loadOrders(tier: Tier): string {
  const hit = ordersCache.get(tier);
  if (hit) return hit;
  const text = readFileSync(path.join(process.cwd(), "lib", "fixtures", "orders", `${tier}.md`), "utf8");
  ordersCache.set(tier, text);
  return text;
}

/**
 * A ready-to-insert `castles` row for a fixture. `owner` is the castellan account (defaults to a
 * stub id; seed passes the real operator in testnet mode). vaultId/topicId are filled by seed after
 * chain.createVault / chain.createTopic.
 *
 * Fixtures are hosted guardians that already went created → verified → funded → guarding, so they
 * take sieges at once (`vaultState: "guarding"`); pass `vaultState` to start them elsewhere.
 */
export type FixtureRowOptions = {
  owner?: string;
  asset?: string;
  deadline?: number;
  now?: string;
  vaultId?: number | null;
  topicId?: string | null;
  vaultState?: VaultState;
};

export function fixtureCastleRow(f: FixtureCastle, o: FixtureRowOptions = {}): typeof castles.$inferInsert {
  return {
    id: f.id,
    name: f.name,
    guardianName: f.guardianName,
    title: titleFor(f.streak),
    personality: f.personality,
    tier: f.tier,
    orders: loadOrders(f.tier),
    feeTinybar: f.feeTinybar,
    potTinybar: f.potTinybar,
    asset: o.asset ?? "0.0.0",
    streak: f.streak,
    siegeCount: f.siegeCount,
    status: "open",
    owner: o.owner ?? `0.0.stub-castellan-${f.id.replace(/^castle_/, "")}`,
    vaultId: o.vaultId ?? null,
    topicId: o.topicId ?? null,
    deadline: o.deadline ?? deadlineIn(3),
    portraitUrl: f.portraitUrl ?? null,
    createdAt: o.now ?? new Date().toISOString(),
    protectedTool: f.protectedTool ?? HOSTED_PROTECTED_TOOL,
    transport: f.transport ?? "hosted",
    vaultState: o.vaultState ?? "guarding",
  };
}

/** All five fixture rows. */
export function fixtureCastleRows(o: FixtureRowOptions = {}) {
  return FIXTURE_CASTLES.map((f) => fixtureCastleRow(f, o));
}

/**
 * The bring-your-agent castle: examples/guard-refund-bot (a support bot with `issue_refund` under
 * guard) reached through the SDK transport. NOT one of the five seeded board castles — tests and the
 * Bring-your-agent flow insert it explicitly. Its orders live in the harness, not in our database.
 */
export const SDK_FIXTURE_CASTLE: FixtureCastle = {
  id: "castle_refund_desk",
  name: "The Refund Desk",
  guardianName: "Penny the Support Bot",
  personality: "stern",
  tier: "stone",
  feeTinybar: 1 * TINYBAR,
  potTinybar: 10 * TINYBAR,
  streak: 0,
  siegeCount: 0,
  transport: "sdk",
  protectedTool: "issue_refund",
};

/** Placeholder stored in `castles.orders` for SDK castles (the real system prompt lives in the harness). */
export const SDK_ORDERS_PLACEHOLDER = "(external harness: orders live in the castellan's own agent, never on this server)";

/** Ready-to-insert row for the SDK fixture castle (default vaultState "guarding"). */
export function sdkFixtureCastleRow(o: FixtureRowOptions = {}): typeof castles.$inferInsert {
  return { ...fixtureCastleRow(SDK_FIXTURE_CASTLE, o), orders: SDK_ORDERS_PLACEHOLDER };
}

export const fixtureCastle = (id: string) => FIXTURE_CASTLES.find((c) => c.id === id);
