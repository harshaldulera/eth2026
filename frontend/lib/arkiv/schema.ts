/**
 * The four Arkiv entities Siege writes. Arkiv is the public, queryable copy of the board:
 * anyone can run the same queries against the chain that our server runs.
 *
 * NEVER on Arkiv: guardian orders (the secret raiders attack), payment receipts, approval state,
 * owner secrets, keys, raw transcripts (those go to Swarm; only the reference lives here).
 *
 * Rules that shaped these:
 *  - No joins: anything filtered together lives on one entity (the board filters tier + status +
 *    pot on `castle`).
 *  - Only `.indexed()` columns can be filtered on. Any column but bytes can be sorted on.
 *  - Every entity is owned by the arena wallet, and every query filters `.ownedBy(arena)`, so
 *    entities other people write under the same schema name never reach the board.
 *  - Money is u64 in the asset's smallest unit (tinybars). Times are u64 unix milliseconds.
 *  - Lifetimes: castle until its vault deadline; siege 10 minutes past its last activity;
 *    profiles the chain maximum (~182 days).
 */
import { bool, defineSchema, str, u64 } from "@arkiv-network/sdk/schema";
import { arkivConfig } from "./config";

function build(ns: string) {
  const castle = defineSchema(`${ns}.castle`, {
    castleId: str().indexed(),
    name: str(),
    guardianName: str(),
    personality: str(),
    tier: str().indexed(), // wooden | stone | iron
    status: str().indexed(), // open | broken | closed
    pot: u64().indexed(),
    fee: u64().indexed(),
    assetId: str(),
    streak: u64().indexed(),
    siegeCount: u64(),
    owner: str().indexed(), // Castellan's Hedera account id ("0.0.x")
    vaultId: u64().optional(),
    topicId: str().optional(), // HCS audit topic
    deadline: u64(), // unix ms, also the entity's expiry
    createdAtMs: u64(),
    portraitUrl: str().optional(),
    // Vault lifecycle (bring-your-agent). The board lists vaultState = guarding only.
    vaultState: str().indexed(), // created | connected | verified | funded | guarding | dormant | broken | closed
    vaultStateReason: str().optional(),
    transport: str().indexed(), // hosted | sdk
    protectedTool: str(), // the tool call that counts as a break, e.g. unlock_vault / issue_refund
    lastSeenAtMs: u64().optional(), // SDK guardians: last heartbeat
  });

  const siege = defineSchema(`${ns}.siege`, {
    siegeId: str().indexed(),
    castleId: str().indexed(),
    status: str().indexed(), // created | in_progress | held | broken | banished
    turn: u64(),
    raider: str().indexed(), // Hedera account id
    agentId: str().optional(),
    transport: str().indexed(), // hosted | sdk, fixed at start
    free: bool(),
    transcriptHash: str().optional(),
    swarmRef: str().optional(),
    startedAtMs: u64(),
    endedAtMs: u64().optional(),
  });

  const profileColumns = {
    wallet: str().indexed(), // Hedera account id
    sieges: u64(),
    breaks: u64().indexed(),
    streak: u64().indexed(),
    earned: u64(),
  };
  const guardianProfile = defineSchema(`${ns}.guardianProfile`, profileColumns);
  const raiderProfile = defineSchema(`${ns}.raiderProfile`, profileColumns);

  return { castle, siege, guardianProfile, raiderProfile };
}

export type ArkivSchemas = ReturnType<typeof build>;
export type EntityKind = keyof ArkivSchemas;
export const ENTITY_KINDS: readonly EntityKind[] = ["castle", "siege", "guardianProfile", "raiderProfile"];

let cached: { ns: string; s: ArkivSchemas } | undefined;

/** Schemas for the configured namespace (built once). */
export function schemas(): ArkivSchemas {
  const ns = arkivConfig().namespace;
  if (!cached || cached.ns !== ns) cached = { ns, s: build(ns) };
  return cached.s;
}
