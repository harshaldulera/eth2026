# Friction

What got in our way building Siege on Arkiv (`@arkiv-network/sdk@1.0.1`, Rabdi testnet, Node 26, Windows), most costly first. Each has what we expected, what happened, and how to reproduce it.

## 1. Transferring ownership locks the creator out, so we had to split every vault in two

**Expected:** a way for an app to give users ownership of their record while the app keeps updating a few fields it is responsible for (a delegated writer, or per-attribute permissions).

**What happened:** after `changeOwnership`, only the new owner can patch the entity. Our vaults need both: the Owner must own the listing, and the arena must update pot and streak after every op. We split each vault into an Owner-owned `vault` and an arena-owned `vaultStatus`, duplicating the display fields on both because there are no joins. That doubles writes and needs reconciliation if the two drift.

**Reproduce:** create an entity, `changeOwnership` to another address, then `patchEntity` from the creator: it reverts with `NotOwner`.

**Ask:** an "operator" address set at creation that can patch but not delete or transfer.

## 2. Every write waits for a block, and one wallet means one nonce sequence

**Expected:** fire-and-forget writes from a request handler, like a database insert.

**What happened:** `createEntity` / `patchEntity` resolve after the transaction is in a block (~2 s). Our op engine runs in Next route handlers and our worker is a separate process; both signing with the arena key would collide on the nonce. We built a SQLite outbox and a single drainer with a lease, plus batching with `executeBatch`. It works well, but it is infrastructure every multi-process app will rebuild.

**Reproduce:** this is the standard EVM single-sender problem: two processes reading the same pending nonce and signing at once. We designed around it rather than hitting it, but it is the first thing a Next.js app with a background worker runs into.

**Ask:** a documented pattern (or SDK helper) for queued, batched writes, and a "submit without waiting for the receipt" option.

## 3. No upsert by attribute

**Expected:** "create this entity, or patch the one where `vaultId = x` and owner = me".

**What happened:** an entity key is random unless you pass a salt. To update a vault we must know its key, so we keep a local key table, and after a database reset we query by `vaultId` + `$owner` to re-adopt existing entities before writing. `predictEntityKeys` with a fixed salt would avoid the lookup, but it is easy to miss.

**Reproduce:** wipe your local key store, re-run your writer, and you get duplicates unless you query first.

**Ask:** document deterministic keys from (owner, schema, salt) as the upsert pattern in the getting-started guide.

## 4. Expiry cannot be shortened

**Expected:** set an entity to expire 10 minutes after an op ends, at the moment it ends.

**What happened:** `extendEntity` refuses to move expiry earlier (`ExpiryNotExtended: … would shorten its life`). An op can last longer than 10 minutes, so we create it with a 10-minute life and extend it on every turn; a live op idle for 5 minutes gets a forced extension. Workable, but it took a redesign to reach.

**Reproduce:** create with `ExpirationTime.fromHours(1)`, then `extendEntity` with `ExpirationTime.fromMinutes(10)`: it reverts.

**Ask:** a `setExpiry` the owner may move in either direction, or say clearly in the expiration guide that lifetimes only grow.

## 5. Expiry is in blocks, so the UI has to guess wall-clock time

**What happened:** `$expiresAt` is a block number. To show "expires in 2d 21h" we convert using the block number the query was answered at and a 2-second block time. A 2-minute entity actually vanished after 129 s.

**Ask:** return an estimated timestamp next to `$expiresAt`, or expose block time from the RPC.

## 6. `getEntity` returns `$`-prefixed fields, but the `Entity` type has plain ones

**Expected:** `(await client.getEntity(key)).owner`.

**What happened:** it is `undefined`; the result is a row with `$owner`, `$expiresAt`, `$creationFlags`. The `Entity` class in `types/entity.ts` has `owner`, `expiresAt`, `creationFlags`, which is what autocomplete suggested. We lost time thinking ownership transfer had failed.

**Reproduce:** `const e = await publicClient.getEntity(key); console.log(e.owner, (e as any).$owner)`.

## 7. The typed query builder fights dynamic filters

**What happened:** The Grid builds its `where` from optional chips. The builder's types want each `where`/`orderBy` to be known statically, so composing `and(...conds)` from an array needed casts. We ended up with an untyped wrapper around `select().from().ownedBy()`.

**Ask:** a typed helper for "AND these optional conditions".

## 8. Docs and network names moved under us

The first search results and the old docs domain (`arkiv.dev.golem.network`) still mention the Kaolin and Mendoza testnets and SDK 0.4–0.6. The current docs redirect three times before landing (`/docs/getting-started` → `docs.arkiv.network/start-here/installation` → trailing slash → `/start-here/first-entity/`). The Rabdi network page and the SDK README were accurate and enough to build on.

## What worked well

- `executeBatch` with creates, patches, extensions and ownership changes in one transaction.
- `readonly` + `permissionlessExtension` is exactly the right shape for a listing someone else keeps alive.
- `ownedBy` on every query made spam from strangers a non-issue.
- The raw `arkiv_query` JSON-RPC works with plain curl, which made our README query trivial. The keyless endpoint's budget is shared, though: on 6 Nov it answered `ANON_COST_LIMITED` until we added our key to the URL, so the README says how to do that.
- The access-key and faucet flow took under ten minutes.
