# Why Arkiv

## If we swapped Arkiv for Postgres, what would users lose?

**Castellans would not own their listing.** On Arkiv a castle's listing belongs to the Castellan's wallet, the same key that owns the vault on Hedera. It is readonly, so we cannot rewrite their castle's name, tier or protected tool, and only they can delete it. In Postgres the row would be ours: we could edit it, hide it or keep it up after they wanted it gone, and they would have to ask us to delist.

**Raiders could only find castles through our API.** Today the board, the raider's target picker and anyone's script read the same query from the chain (see [how-you-use-arkiv.md](how-you-use-arkiv.md)). Someone building their own raider bot can discover castles, pots and live sieges without our server and without trusting our numbers to match what we show. With Postgres, discovery dies with our API, and the "open arena" is just our website.

**Claims would need a janitor.** A siege is a raider's claim on a castle. On Arkiv it disappears ten minutes after it ends, and a castle disappears at its vault deadline. In Postgres we would need a cleanup job, and anyone reading our API would have to trust that it ran.

**Our history would be ours to edit.** The arena's own records (pots, streaks, siege outcomes) are signed writes from one public wallet, readable by anyone at any block. In Postgres we could quietly change a streak.

## What we kept off Arkiv, and why

| Kept off | Why | Where it lives |
|---|---|---|
| Guardian orders | They are the secret raiders try to extract. Publishing them ends the game. | Server database, never logged; a hash is committed on HCS |
| Payment receipts, refunds | Money is on Hedera already: x402 settlement and the SiegeVault contract are the source of truth | Hedera (HashScan) + server database |
| Raider approval requests, owner secrets | Private to the agent's owner | Server database |
| 0G proxy request records | Used only by our verifier; hashes, not content | Server database |
| Raw transcripts | Too large for an entity attribute and private until a siege ends | Swarm; Arkiv holds the reference and the hash |

The rule: Arkiv holds what many parties need to find, filter and trust without asking us. Everything secret or already settled on Hedera stays off.
