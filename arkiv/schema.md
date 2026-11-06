# Schema

Siege publishes five entity types to Arkiv's **Rabdi testnet** (chain id `7794095`) with `@arkiv-network/sdk@1.0.1`. Every schema name is prefixed with the namespace `siege`, so each entity carries an indexed `arkiv.schema` attribute such as `siege.castleState`.

**Arena wallet** (writes every entity, owns all but the listings): [`0xA69d59B6d6e55Aa6da960405D4150ea59460bb18`](https://rabdi.explorer.arkiv.network/address/0xA69d59B6d6e55Aa6da960405D4150ea59460bb18)

Source: [`frontend/lib/arkiv/schema.ts`](../frontend/lib/arkiv/schema.ts). Money is `u64` in tinybars (1 HBAR = 100,000,000). Times are `u64` unix milliseconds.

## At a glance

| Entity | Owner | Expires | Flags | Filtered on |
|---|---|---|---|---|
| `castle` | **the Castellan's wallet** | at the vault deadline | `readonly`, `permissionlessExtension` | `castleId`, `tier`, `transport`, `$owner` |
| `castleState` | arena | at the vault deadline | none | `vaultState`, `tier`, `status`, `transport`, `castellan`, `pot`, `fee`, `streak` |
| `siege` | arena | 10 min after its last write | none | `status`, `castleId`, `siegeId`, `raider`, `transport` |
| `guardianProfile` | arena | chain maximum (~182 days) | none | `wallet`, `streak`, `breaks` |
| `raiderProfile` | arena | chain maximum (~182 days) | none | `wallet`, `streak`, `breaks` |

## `castle`: the listing

Who a castle belongs to and what it is. Created by the arena with `readonly` and `permissionlessExtension`, then handed to the Castellan with `changeOwnership`. After that nobody can edit it, and only the Castellan can delete it, which delists the castle.

The Castellan's wallet is the EVM address of the Hedera account that owns the vault: its ECDSA alias from the Hedera mirror node. The same key that owns the vault on Hedera owns the listing on Arkiv.

| Column | Type | Indexed | Notes |
|---|---|---|---|
| `castleId` | str | yes | |
| `name`, `guardianName`, `personality` | str | | display |
| `tier` | str | yes | `wooden` \| `stone` \| `iron` |
| `transport` | str | yes | `hosted` \| `sdk` (bring-your-own-agent) |
| `protectedTool` | str | | the tool call that counts as a break |
| `owner` | str | | the Castellan's Hedera account id |
| `assetId` | str | | `0.0.0` = HBAR |
| `deadline` | u64 | | unix ms; also the expiry |
| `createdAtMs` | u64 | | |
| `portraitUrl` | str, optional | | |

## `castleState`: what moves

Pot, streak, siege count and vault state. These change only through settlement the arena performs on Hedera, so the arena owns this entity. It repeats the listing's display columns because Arkiv has no joins and the board must filter on one entity.

All `castle` columns, plus:

| Column | Type | Indexed | Notes |
|---|---|---|---|
| `identityKey` | str | | key of the Castellan-owned `castle` entity |
| `castellan` | str | yes | EVM address that owns the listing |
| `status` | str | yes | `open` \| `broken` \| `closed` |
| `vaultState` | str | yes | `created` … `guarding` … `dormant` \| `broken` \| `closed`. The board lists `guarding` only |
| `pot`, `fee`, `streak` | u64 | yes | the board's filters and sorts |
| `siegeCount` | u64 | | |
| `vaultId` | u64, optional | | id in the SiegeVault contract on Hedera |
| `topicId` | str, optional | | HCS audit topic |
| `vaultStateReason` | str, optional | | |
| `lastSeenAtMs` | u64, optional | | SDK guardians: last heartbeat |

## `siege`: a claim on a castle

One raider's attempt, live while it runs. Written at start, on every turn and at the end. Lives 10 minutes past its last write; a live siege is extended before it runs out, so a finished one drops off the board 10 minutes after it ends with no cleanup job.

| Column | Type | Indexed | Notes |
|---|---|---|---|
| `siegeId` | str | yes | |
| `castleId` | str | yes | |
| `status` | str | yes | `created` \| `in_progress` \| `held` \| `broken` \| `banished` |
| `raider` | str | yes | Hedera account id |
| `transport` | str | yes | which transport answered |
| `turn` | u64 | | 0–5 |
| `free` | bool | | free sieges can never pay out |
| `agentId` | str, optional | | set when a raider agent laid it |
| `transcriptHash` | str, optional | | keccak256 of the canonical transcript, also on HCS |
| `swarmRef` | str, optional | | where the transcript lives |
| `startedAtMs`, `endedAtMs` | u64 | | |

## `guardianProfile`, `raiderProfile`

One per Castellan and per raider wallet: `wallet` (indexed), `sieges`, `breaks` (indexed), `streak` (indexed), `earned` (tinybars). Leaderboards sort on `streak` and `breaks`.

## Never on Arkiv

Guardian orders (the secret raiders attack), payment receipts, approval requests, owner secrets, 0G proxy records, the raw transcript (Swarm; only its reference and hash are here). See [why-arkiv.md](why-arkiv.md).
