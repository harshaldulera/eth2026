/**
 * The Arkiv entities Siege writes. Arkiv is the public, queryable copy of the board: anyone can run
 * the same queries against the chain that our server runs.
 *
 * NEVER on Arkiv: guardian orders (the secret raiders attack), payment receipts, approval state,
 * owner secrets, keys, raw transcripts (those go to Swarm; only the reference lives here).
 *
 * A castle is two entities, because on Arkiv only an entity's owner may change it:
 *
 *  - `castle` is the listing, OWNED BY THE CASTELLAN. The arena creates it readonly and hands
 *    ownership to the Castellan's wallet (the EVM address of the Hedera account that owns the vault).
 *    Nobody can edit it afterwards, and only the Castellan can delete it, which is how they delist.
 *    It expires at the vault deadline; `permissionlessExtension` lets the arena push that out when
 *    a vault is re-armed without taking ownership back.
 *  - `castleState` holds everything that moves (pot, streak, status, vault state) and is OWNED BY
 *    THE ARENA, because those values change only through settlement the arena performs on Hedera.
 *    It repeats the listing's display fields so the board reads one entity (Arkiv has no joins),
 *    and carries the key of the Castellan-owned `castle` it belongs to.
 *
 * Other rules: only `.indexed()` columns can be filtered on; any column but bytes can be sorted on;
 * every query filters `.ownedBy(...)` so strangers writing under our schema names never reach the
 * board. Money is u64 in the asset's smallest unit (tinybars). Times are u64 unix milliseconds.
 * Sieges live 10 minutes past their last write; profiles the chain maximum (~182 days).
 */
import { bool, defineSchema, str, u64 } from "@arkiv-network/sdk/schema";
import { arkivConfig } from "./config";

/** Display fields a card needs. On both castle entities (see the file comment). */
const listing = {
  castleId: str().indexed(),
  name: str(),
  guardianName: str(),
  personality: str(),
  tier: str().indexed(), // wooden | stone | iron
  transport: str().indexed(), // hosted | sdk
  protectedTool: str(), // the tool call that counts as a break, e.g. unlock_vault / issue_refund
  owner: str(), // Castellan's Hedera account id ("0.0.x")
  assetId: str(),
  deadline: u64(), // unix ms; both entities expire here
  createdAtMs: u64(),
  portraitUrl: str().optional(),
};

function build(ns: string) {
  const castle = defineSchema(`${ns}.castle`, listing);

  const castleState = defineSchema(`${ns}.castleState`, {
    ...listing,
    identityKey: str(), // key of the Castellan-owned `castle` entity
    castellan: str().indexed(), // EVM address that owns that entity
    status: str().indexed(), // open | broken | closed
    pot: u64().indexed(),
    fee: u64().indexed(),
    streak: u64().indexed(),
    siegeCount: u64(),
    vaultId: u64().optional(),
    topicId: str().optional(), // HCS audit topic
    vaultState: str().indexed(), // created | connected | verified | funded | guarding | dormant | broken | closed
    vaultStateReason: str().optional(),
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

  return { castle, castleState, siege, guardianProfile, raiderProfile };
}

export type ArkivSchemas = ReturnType<typeof build>;
export type EntityKind = keyof ArkivSchemas;
export const ENTITY_KINDS: readonly EntityKind[] = ["castle", "castleState", "siege", "guardianProfile", "raiderProfile"];

let cached: { ns: string; s: ArkivSchemas } | undefined;

/** Schemas for the configured namespace (built once). */
export function schemas(): ArkivSchemas {
  const ns = arkivConfig().namespace;
  if (!cached || cached.ns !== ns) cached = { ns, s: build(ns) };
  return cached.s;
}
