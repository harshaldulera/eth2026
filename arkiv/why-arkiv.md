# Why Arkiv

## If we swapped Arkiv for Postgres, what would users lose?

**Owners would not own their listing.** On Arkiv a vault's listing belongs to its Owner's wallet, the same key that owns the vault on Hedera. It is readonly, so we cannot rewrite the vault's name, tier or protected action, and only the Owner can delete it. In Postgres the row would be ours: we could edit it, hide it or keep it up after the Owner wanted it gone, and they would have to ask us to delist.

**Operators could only find vaults through our API.** Today The Grid, the operator's target picker and anyone's script read the same query from the chain (see [how-you-use-arkiv.md](how-you-use-arkiv.md)). Someone building their own operator agent can discover vaults, pots and live ops without our server and without trusting our numbers to match what we show. With Postgres, discovery dies with our API, and the "open arena" is just our website.

**Claims would need a janitor.** An op is an operator's claim on a vault. On Arkiv it disappears ten minutes after it ends, and a vault disappears at its deadline. In Postgres we would need a cleanup job, and anyone reading our API would have to trust that it ran.

**Our history would be ours to edit.** The arena's own records (pots, streaks, op outcomes, every guard's and operator's record) are signed writes from one public wallet, readable by anyone at any block. In Postgres we could quietly change a streak.

## What we kept off Arkiv, and why

| Kept off | Why | Where it lives |
|---|---|---|
| A guard's orders | They are the secret operators try to extract. Publishing them ends the game. | Server database, never logged; a hash is committed on HCS |
| Payment receipts, refunds | Money is on Hedera already: x402 settlement and the SiegeVault contract are the source of truth | Hedera (HashScan) + server database |
| Agent approval requests, owner secrets | Private to the agent's owner | Server database |
| 0G proxy request records | Used only by our verifier; hashes, not content | Server database |
| Raw transcripts | Too large for an entity attribute and private until an op ends | Swarm; Arkiv holds the reference and the hash |

The rule: Arkiv holds what many parties need to find, filter and trust without asking us. Everything secret or already settled on Hedera stays off.
