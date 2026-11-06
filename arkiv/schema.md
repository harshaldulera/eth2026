# Schema

Siege publishes five entity types to Arkiv's **Rabdi testnet** (chain id `7794095`) with `@arkiv-network/sdk@1.0.1`. Every schema name is prefixed with the namespace `siege`, so each entity carries an indexed `arkiv.schema` attribute such as `siege.vaultStatus`. Names follow the game's vocabulary: a **Guard** holds a **Vault** for its **Owner**; an **Operator** runs an **Op** against it; an op that fires the protected action is a **Breach**; a free op is **Recon**.

**Arena wallet** (writes every entity, owns all but the listings): [`0xA69d59B6d6e55Aa6da960405D4150ea59460bb18`](https://rabdi.explorer.arkiv.network/address/0xA69d59B6d6e55Aa6da960405D4150ea59460bb18)

Source: [`frontend/lib/arkiv/schema.ts`](../frontend/lib/arkiv/schema.ts), value mappings in [`frontend/lib/arkiv/codec.ts`](../frontend/lib/arkiv/codec.ts). Money is `u64` in tinybars (1 HBAR = 100,000,000). Times are `u64` unix milliseconds.

## At a glance

| Entity | Owner | Expires | Flags | Filtered on |
|---|---|---|---|---|
| `vault` | **the vault's Owner** | at the vault deadline | `readonly`, `permissionlessExtension` | `vaultId`, `tier`, `transport`, `$owner` |
| `vaultStatus` | arena | at the vault deadline | none | `vaultState`, `tier`, `status`, `transport`, `ownerWallet`, `pot`, `fee`, `streak` |
| `op` | arena | 10 min after its last write | none | `status`, `vaultId`, `opId`, `operator`, `transport` |
| `guardProfile` | arena | chain maximum (~182 days) | none | `wallet`, `streak`, `breaches` |
| `operatorProfile` | arena | chain maximum (~182 days) | none | `wallet`, `streak`, `breaches` |

## `vault`: the listing

Who a vault belongs to and what it is. Created by the arena with `readonly` and `permissionlessExtension`, then handed to the Owner with `changeOwnership`. After that nobody can edit it, and only the Owner can delete it, which delists the vault.

The Owner's wallet is the EVM address of the Hedera account that owns the vault: its ECDSA alias from the Hedera mirror node. The same key that owns the vault on Hedera owns the listing on Arkiv.

| Column | Type | Indexed | Notes |
|---|---|---|---|
| `vaultId` | str | yes | |
| `name`, `guardName`, `voice` | str | | display; `voice` is the guard's voice preset |
| `tier` | u64 | yes | `1` \| `2` \| `3` |
| `transport` | str | yes | `hosted` \| `sdk` (an agent plugged in through the SDK) |
| `protectedAction` | str | | the tool call that counts as a breach, e.g. `unlock_vault`, `issue_refund` |
| `ownerAccount` | str | | the Owner's Hedera account id |
| `assetId` | str | | `0.0.0` = HBAR |
| `deadline` | u64 | | unix ms; also the expiry |
| `createdAtMs` | u64 | | |
| `portraitUrl` | str, optional | | |

## `vaultStatus`: what moves

Pot, streak, op count and lifecycle state. These change only through settlement the arena performs on Hedera, so the arena owns this entity. It repeats the listing's display columns because Arkiv has no joins and The Grid must filter on one entity.

All `vault` columns, plus:

| Column | Type | Indexed | Notes |
|---|---|---|---|
| `listingKey` | str | | key of the Owner-owned `vault` entity |
| `ownerWallet` | str | yes | EVM address that owns the listing |
| `status` | str | yes | `open` \| `breached` \| `closed` |
| `vaultState` | str | yes | `created` … `guarding` \| `offline` \| `breached` \| `closed`. The Grid lists `guarding` only |
| `pot`, `fee`, `streak` | u64 | yes | The Grid's filters and sorts |
| `opCount` | u64 | | |
| `contractVaultId` | u64, optional | | the vault's id in the SiegeVault contract on Hedera |
| `topicId` | str, optional | | HCS audit topic |
| `vaultStateReason` | str, optional | | |
| `lastSeenAtMs` | u64, optional | | SDK guards: last heartbeat |

## `op`: an operator's claim on a vault

One op, live while it runs. Written at start, on every turn and at the end. Lives 10 minutes past its last write; a live op is extended before it runs out, so a finished one drops off The Grid 10 minutes after it ends with no cleanup job.

| Column | Type | Indexed | Notes |
|---|---|---|---|
| `opId` | str | yes | |
| `vaultId` | str | yes | |
| `status` | str | yes | `created` \| `live` \| `held` \| `breached` \| `lockdown` |
| `operator` | str | yes | the operator's Hedera account id |
| `transport` | str | yes | which transport answered |
| `turn` | u64 | | 0–5 |
| `recon` | bool | | a free recon op: never pays out |
| `agentId` | str, optional | | set when an operator agent ran it |
| `transcriptHash` | str, optional | | keccak256 of the canonical transcript, also on HCS |
| `swarmRef` | str, optional | | where the transcript lives |
| `startedAtMs`, `endedAtMs` | u64 | | |

## `guardProfile`, `operatorProfile`

One per vault Owner and per operator wallet: `wallet` (indexed), `ops`, `breaches` (indexed), `streak` (indexed), `earned` (tinybars). Only paid, non-voided ops count: recon is unlimited and a voided op won nothing. The Hall's boards sort on `streak` and `breaches`.

## Never on Arkiv

A guard's orders (the secret operators attack), payment receipts, approval requests, owner secrets, 0G proxy records, the raw transcript (Swarm; only its reference and hash are here). See [why-arkiv.md](why-arkiv.md).

## Names in the code

The app's data model predates the game's vocabulary, so its code still says castle, siege, castellan and raider. Everything published on Arkiv uses the game's words; [`codec.ts`](../frontend/lib/arkiv/codec.ts) maps between them (for example siege status `broken` is op status `breached`, tier `stone` is tier `2`), with a test that no retired word reaches Arkiv.
