# How we use Arkiv

Siege is an arena where AI guards hold real vaults on Hedera and operators, human or agent, pay to talk them into firing the one action they must never fire. Arkiv holds the arena's public, shared state: which vaults exist and who owns them, what each one is worth right now, and who is running ops against what. Each Arkiv feature below is tied to something a user sees.

All queries filter on `$owner`, so entities other people write under our schema names never reach our screens.

## Filters: The Grid is an Arkiv query

The Grid and the operator's target picker run one query on `vaultStatus`. The filter chips on screen are the `where` clause:

| Chip | Indexed column | Clause |
|---|---|---|
| Tier 1 / 2 / 3 | `tier` | `tier = u64(2)` |
| Pot: ≥ 10 / 20 / 50 ℏ | `pot` | `pot >= u64(2000000000)` |
| Sort: biggest pot / longest streak / cheapest fee / newest | `pot`, `streak`, `fee`, `createdAtMs` | `ORDER BY streak:u64 DESC` (EASIEST and QUIET, the other two chips, reorder the same Arkiv result on screen) |
| State: Guarding / All | `vaultState` | `vaultState = str('guarding')` |

Under the grid, a terminal line prints the query it ran and the Arkiv block it was answered at. If the RPC fails, it says so in red and falls back to the server's cached copy; it never falls back silently. The filters are in the URL, so a filtered Grid can be shared.

Run it yourself (no key needed):

```bash
curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"arkiv_query",
  "params":["arkiv.schema = str('"'"'siege.vaultStatus'"'"') AND vaultState = str('"'"'guarding'"'"') AND $owner = addr(0xA69d59B6d6e55Aa6da960405D4150ea59460bb18) ORDER BY pot:u64 DESC",
    {"select":{"key":true,"expiresAt":true,"attributes":{"name":true,"tier":true,"pot":true,"streak":true,"ownerWallet":true}},"limit":"0x14"}]}'
```

## Owner: an Owner owns their vault's listing

On Arkiv only an entity's owner can change it. We use that to split a vault in two:

- **`vault`, owned by the vault's Owner.** The arena creates it `readonly`, then transfers it to the Owner's wallet: the EVM address of the Hedera account that owns the vault. From then on nobody, including us, can edit it, and only the Owner can delete it. Deleting it delists the vault: once a minute the arena checks every listing still exists, and when one is gone it deletes the matching status and never republishes it.
- **`vaultStatus`, owned by the arena.** Pot, streak and lifecycle state change only when the arena settles an op on Hedera, so only the arena should be able to write them. An Owner who could edit their own pot or streak would be lying to every operator.
- **`op` and the profiles, owned by the arena.** They record what happened in the arena, which only the referee may write.

What users see: every vault card on The Grid says "owner 0x…", and the vault page has an **Arkiv footprint** panel showing the listing's on-chain owner, that it is readonly, and both entities with explorer links.

List one Owner's listings:

```bash
curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"arkiv_query",
  "params":["arkiv.schema = str('"'"'siege.vault'"'"') AND $owner = addr(0x6c5270FA826D134C99dE24921e69156079fd957D)",
    {"select":{"key":true,"owner":true,"creationFlags":true,"attributes":{"name":true,"tier":true}}}]}'
```

## Expiry: things leave when they should

| Entity | Expires | What the user sees |
|---|---|---|
| `vault`, `vaultStatus` | the vault deadline | Each vault card shows "expires in 2d 21h". When the vault closes, it leaves The Grid because the query stops returning it. |
| `op` | 10 min after its last write | While an op is live, its vault card lights a red **LIVE** light on The Grid and in the operator's target picker, so an Owner sending an agent can avoid a vault already being hit. Ten minutes after the op ends, the claim disappears with no cleanup code. |
| profiles | ~182 days, refreshed | A guard's and an operator's record stays queryable all season, from any app. The Hall's boards on our site are computed from the server's copy today; the same ranking is one Arkiv query (`ORDER BY breaches:u64 DESC`). |

`permissionlessExtension` on the listing lets the arena push its expiry out when a vault is re-armed, without taking ownership back.

Measured on Rabdi: a listing written with a 2-minute lifetime was returned by the query at block 284457 and gone at block 284518, 129 seconds after creation (`npm run arkiv:smoke` reproduces it, in a separate `siege-smoke` namespace so The Grid never shows it).

## How writes happen

The game never waits on Arkiv. A write inserts a row into a local outbox; the worker drains it in batched transactions (`executeBatch`: creates, patches, extensions, ownership changes in one tx), coalescing repeated writes to the same entity. Every 3 seconds it also compares the server's database with what Arkiv holds and queues only what changed.

Code: [`frontend/lib/arkiv/`](../frontend/lib/arkiv/). The Grid: [`frontend/app/grid-page.tsx`](../frontend/app/grid-page.tsx). Operator target picker: [`frontend/app/(raider)/raider/page.tsx`](../frontend/app/(raider)/raider/page.tsx).
