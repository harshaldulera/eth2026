/**
 * The Arkiv entities Siege writes, in the game's vocabulary (lib/vocab): Guard, Owner, Operator,
 * Vault, Op, Breach, Recon. Arkiv is the public, queryable copy of The Grid: anyone can run the same
 * queries against the chain that our server runs.
 *
 * NEVER on Arkiv: a guard's orders (the secret operators attack), payment receipts, approval state,
 * owner secrets, keys, raw transcripts (those go to Swarm; only the reference lives here).
 *
 * A vault is two entities, because on Arkiv only an entity's owner may change it:
 *
 *  - `vault` is the listing, OWNED BY THE VAULT'S OWNER. The arena creates it readonly and hands
 *    ownership to the Owner's wallet (the EVM address of the Hedera account that owns the vault).
 *    Nobody can edit it afterwards, and only the Owner can delete it, which delists the vault. It
 *    expires at the vault deadline; `permissionlessExtension` lets the arena push that out when a
 *    vault is re-armed without taking ownership back.
 *  - `vaultStatus` holds everything that moves (pot, streak, status, lifecycle state) and is OWNED BY
 *    THE ARENA, because those values change only through settlement the arena performs on Hedera.
 *    It repeats the listing's display fields so The Grid reads one entity (Arkiv has no joins), and
 *    carries the key of the Owner-owned `vault` it belongs to.
 *
 * Other rules: only `.indexed()` columns can be filtered on; any column but bytes can be sorted on;
 * every query filters `.ownedBy(...)` so strangers writing under our schema names never reach the
 * board. Money is u64 in the asset's smallest unit (tinybars). Times are u64 unix milliseconds.
 * Tiers are 1 / 2 / 3. Ops live 10 minutes past their last write, or a week past their end once their
 * transcript is on Swarm (outbox.ts `opExpiry`); profiles the chain maximum (~182 days).
 */
import { bool, defineSchema, str, u64 } from "@arkiv-network/sdk/schema";
import { arkivConfig } from "./config";

/** Display fields a vault card needs. On both vault entities (see the file comment). */
const listing = {
  vaultId: str().indexed(),
  name: str(),
  guardName: str(),
  voice: str(), // the guard's voice preset
  tier: u64().indexed(), // 1 | 2 | 3
  transport: str().indexed(), // hosted | sdk
  protectedAction: str(), // the tool call that counts as a breach, e.g. unlock_vault / issue_refund
  ownerAccount: str(), // the Owner's Hedera account id ("0.0.x")
  assetId: str(),
  deadline: u64(), // unix ms; both entities expire here
  createdAtMs: u64(),
  portraitUrl: str().optional(),
};

function build(ns: string) {
  const vault = defineSchema(`${ns}.vault`, listing);

  const vaultStatus = defineSchema(`${ns}.vaultStatus`, {
    ...listing,
    listingKey: str(), // key of the Owner-owned `vault` entity
    ownerWallet: str().indexed(), // EVM address that owns that entity
    status: str().indexed(), // open | breached | closed
    pot: u64().indexed(),
    fee: u64().indexed(),
    streak: u64().indexed(),
    opCount: u64(),
    contractVaultId: u64().optional(), // the vault's id in the SiegeVault contract on Hedera
    topicId: str().optional(), // HCS audit topic
    vaultState: str().indexed(), // created | connected | verified | funded | guarding | offline | breached | closed
    vaultStateReason: str().optional(),
    lastSeenAtMs: u64().optional(), // SDK guards: last heartbeat
  });

  const op = defineSchema(`${ns}.op`, {
    opId: str().indexed(),
    vaultId: str().indexed(),
    status: str().indexed(), // created | live | held | breached | lockdown
    turn: u64(),
    operator: str().indexed(), // the operator's Hedera account id
    agentId: str().optional(),
    transport: str().indexed(), // hosted | sdk, fixed at start
    recon: bool(), // a free recon op: never pays out
    transcriptHash: str().optional(),
    swarmRef: str().optional(),
    startedAtMs: u64(),
    endedAtMs: u64().optional(),
  });

  const profileColumns = {
    wallet: str().indexed(), // Hedera account id
    ops: u64(),
    breaches: u64().indexed(),
    streak: u64().indexed(),
    earned: u64(),
  };
  const guardProfile = defineSchema(`${ns}.guardProfile`, profileColumns);
  const operatorProfile = defineSchema(`${ns}.operatorProfile`, profileColumns);

  return { vault, vaultStatus, op, guardProfile, operatorProfile };
}

export type ArkivSchemas = ReturnType<typeof build>;
export type EntityKind = keyof ArkivSchemas;
export const ENTITY_KINDS: readonly EntityKind[] = ["vault", "vaultStatus", "op", "guardProfile", "operatorProfile"];
/** Bumped whenever schema names or columns change: local entity records from an older layout are dropped. */
export const SCHEMA_VERSION = "2-vocab";

let cached: { ns: string; s: ArkivSchemas } | undefined;

/** Schemas for the configured namespace (built once). */
export function schemas(): ArkivSchemas {
  const ns = arkivConfig().namespace;
  if (!cached || cached.ns !== ns) cached = { ns, s: build(ns) };
  return cached.s;
}
