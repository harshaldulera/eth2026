# How we use Arkiv

Siege is an arena where AI guardians hold real vaults on Hedera and raiders, human or agent, pay to talk them into opening. Arkiv holds the arena's public, shared state: which castles exist and who owns them, what each one is worth right now, and who is attacking what. Each Arkiv feature below is tied to something a user sees.

All queries filter on `$owner`, so entities other people write under our schema names never reach our screens.

## Filters: the board is an Arkiv query

The arena board and the raider's target picker run one query on `castleState`. The chips on screen are the `where` clause:

| Chip | Indexed column | Clause |
|---|---|---|
| Tier: Wooden / Stone / Iron | `tier` | `tier = str('stone')` |
| Pot: ≥ 10 / 20 / 50 ℏ | `pot` | `pot >= u64(2000000000)` |
| Sort: biggest pot / longest streak / cheapest fee / newest | `pot`, `streak`, `fee`, `createdAtMs` | `ORDER BY streak:u64 DESC` |
| State: Guarding / All | `vaultState` | `vaultState = str('guarding')` |

Under the grid, the board prints the query it ran and the Arkiv block it was answered at, with a link to that block. If the RPC fails, the board says so in a red banner and falls back to the server's cached copy; it never falls back silently. The filters are in the URL, so a filtered board can be shared: `/?tier=stone&sort=streak`.

Run it yourself (no key needed):

```bash
curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"arkiv_query",
  "params":["arkiv.schema = str('"'"'siege.castleState'"'"') AND vaultState = str('"'"'guarding'"'"') AND $owner = addr(0xA69d59B6d6e55Aa6da960405D4150ea59460bb18) ORDER BY pot:u64 DESC",
    {"select":{"key":true,"expiresAt":true,"attributes":{"name":true,"tier":true,"pot":true,"streak":true,"castellan":true}},"limit":"0x14"}]}'
```

## Owner: a Castellan owns their listing

On Arkiv only an entity's owner can change it. We use that to split a castle in two:

- **`castle`, owned by the Castellan.** The arena creates it `readonly`, then transfers it to the Castellan's wallet: the EVM address of the Hedera account that owns the vault. From then on nobody, including us, can edit it, and only the Castellan can delete it. Deleting it delists the castle: once a minute the arena checks every listing still exists, and when one is gone it deletes the matching state and never republishes it.
- **`castleState`, owned by the arena.** Pot, streak and vault state change only when the arena settles a siege on Hedera, so only the arena should be able to write them. A Castellan who could edit their own pot or streak would be lying to every raider.
- **`siege` and profiles, owned by the arena.** They record what happened in the arena, which only the referee may write.

What users see: every card says "owned by 0x…", and the castle page has an **On Arkiv** card showing the listing's on-chain owner, that it is readonly, and both entities with explorer links.

List one Castellan's listings:

```bash
curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"arkiv_query",
  "params":["arkiv.schema = str('"'"'siege.castle'"'"') AND $owner = addr(0x6c5270FA826D134C99dE24921e69156079fd957D)",
    {"select":{"key":true,"owner":true,"creationFlags":true,"attributes":{"name":true,"tier":true}}}]}'
```

## Expiry: things leave when they should

| Entity | Expires | What the user sees |
|---|---|---|
| `castle`, `castleState` | the vault deadline | Each card shows "expires in 2d 21h". When the vault closes, the castle leaves the board because the query stops returning it. |
| `siege` | 10 min after its last write | While a siege is live, its castle shows **Under siege** on the board and in the raider's target picker, so an owner sending an agent can avoid a castle already being attacked. Ten minutes after the siege ends, the claim disappears with no cleanup code. |
| profiles | ~182 days, refreshed | Leaderboards stay put while the season runs. |

`permissionlessExtension` on the listing lets the arena push its expiry out when a vault is re-armed, without taking ownership back.

Measured on Rabdi: a castle written with a 2-minute lifetime was returned by the board query at block 284457 and gone at block 284518, 129 seconds after creation (`npm run arkiv:smoke` reproduces it).

## How writes happen

The game never waits on Arkiv. A write inserts a row into a local outbox; the worker drains it in batched transactions (`executeBatch`: creates, patches, extensions, ownership changes in one tx), coalescing repeated writes to the same entity. Every 3 seconds it also compares the server's database with what Arkiv holds and queues only what changed. First sync of six castles: listings in one transaction, ownership transfers plus 6 states and 6 profiles in three.

Code: [`frontend/lib/arkiv/`](../frontend/lib/arkiv/). Board: [`frontend/app/page.tsx`](../frontend/app/page.tsx). Raider picker: [`frontend/app/(raider)/raider/page.tsx`](../frontend/app/(raider)/raider/page.tsx).
