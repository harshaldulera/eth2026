# Swarm: the archive

Every finished op (siege) leaves a transcript: the operator's messages and the guard's replies. Arkiv holds the op entity, with the transcript's hash. Swarm holds the transcript itself, encrypted. The replay page reads it back from Swarm, recomputes the hash and checks it against the hash on the entity and on the Hedera audit topic.

Bonus claimed: **yes**, with the public gateway's stamps (see "Postage" below).

## What lives where

| | Where | Why |
|---|---|---|
| The op entity: op id, vault, status, turns, operator, `transcriptHash`, `swarmRef` | Arkiv (`siege` schema, [schema.md](schema.md)) | Small, queryable, expires minutes after the op ends |
| The transcript: every message, turn by turn, sealed | Swarm | Too big for an entity attribute; must outlive our server |
| Guard orders, payments, approvals, keys | Neither | Secrets and money never go on a public store |

The field is `swarmRef` on the `siege` entity: the bare 64-hex Swarm reference. It is written only after the upload succeeded (`lib/siege/stub.ts` calls `swarm.put` and then `arkiv.writeSiege`; the Arkiv outbox reads the reference from `swarm_refs`).

## An entity and its transcript

_Filled at the freeze with a live op: the entity key on the Rabdi explorer and the `swarmRef` it carries, openable at `https://api.gateway.ethswarm.org/bytes/<ref>` and `https://bzz.limo/bytes/<ref>`._

Until then, a transcript uploaded by `npm run swarm:smoke` on 7 Nov 2026, 20:31 UTC (a fixture op, sealed exactly as a real one):

- reference `186fea9a04704df0acfdedf7280b24109be00d5a9208aa343d94e20b53d3f415`
- https://api.gateway.ethswarm.org/bytes/186fea9a04704df0acfdedf7280b24109be00d5a9208aa343d94e20b53d3f415
- https://bzz.limo/bytes/186fea9a04704df0acfdedf7280b24109be00d5a9208aa343d94e20b53d3f415

What you see at either link is the sealed envelope, not the text (the next section). It stays up as long as the gateway's stamp lasts, about a day; the worker re-uploads real transcripts twice a day, the smoke one is left to lapse.

## What is uploaded

`lib/swarm/crypto.ts`. The transcript JSON is encrypted with AES-256-GCM before it leaves the server:

- key: `HMAC-SHA256(SWARM_TRANSCRIPT_SECRET, "siege-transcript:" + siegeId)`, one key per op
- nonce: the first 12 bytes of `HMAC-SHA256(key, "nonce:" + the transcript JSON)` (a synthetic IV)
- bytes on Swarm: `{"v":1,"alg":"A256GCM","siegeId":"…","nonce":"<hex>","ct":"<base64, tag appended>"}`

Deterministic on purpose: the same transcript always gives the same bytes, so the same Swarm reference. That is what lets the worker re-upload a transcript without the entity ever changing. The nonce is keyed: two different plaintexts under one op's key never share a nonce, and without the key it says nothing about the plaintext (an unkeyed digest would let anyone confirm a guessed transcript offline).

We did not use Swarm's own encryption (`Swarm-Encrypt: true`): its references carry the decryption key, and the reference goes on a public Arkiv entity.

The secret lives only in `frontend/.env` on the server. Lose it and every archived transcript is unreadable; that is the point.

## Postage

We hold no postage batch. Uploads go through Swarm's public gateway, `https://api.gateway.ethswarm.org` (a Bee node behind [ethersphere/swarm-gateway](https://github.com/ethersphere/swarm-gateway)). We send the null batch id (64 zeros) in `Swarm-Postage-Batch-Id`; the gateway replaces it with a batch its own node buys (its stamp manager, `src/stamp.ts`, buys a new depth-17 batch whenever the current one is 85% full or has under an hour left). So:

- batch id used: `0000…0000` (the null stamp), swapped by the gateway
- wallet that bought the batch: the gateway's node, not us; we could not confirm which Gnosis address from the outside (the batch list at `/batches` on the gateway shows one owner buying depth-17 batches every ~40 minutes that last ~25 hours, which matches the gateway's defaults)
- Bee node or service: the public gateway above, through its Bee API (`POST /bytes`, `GET /bytes/{ref}`)

`SWARM_GATEWAY_URL` and `SWARM_POSTAGE_BATCH_ID` switch this to our own node and batch without a code change.

### Retention, and the keep-alive

The gateway's batches last about a day, and it does not top them up. A transcript uploaded on Friday would be gone by Saturday night. Two things handle that:

1. **Keep-alive.** `worker/swarm.ts` re-uploads every transcript from the last week every 12 hours. Same bytes, same reference, now stamped by the gateway's current batch. The entity's `swarmRef` never changes.
2. **Retry.** The op-ending request gives the gateway 2.5 seconds (a normal upload takes about half a second). If it is slow or down, the sealed bytes wait in `swarm_uploads` and the worker retries with backoff (1, 2, 4 … minutes, at most an hour) and a 10-second budget; the same backoff covers keep-alive failures, and a pass stops after three failures in a row rather than timing out on every row. Until it lands, the op entity has no `swarmRef` and the replay says "sealed, upload to Swarm pending" (or "no worker is running to retry it": the worker leaves a heartbeat in the database, so the page reports what is true across processes). When it lands, the worker re-queues the op through the Arkiv port, so the entity gets its `swarmRef` after all.
3. **Revive on open.** If a replay's reference stops resolving (an outage, or a transcript past the one-week horizon), the page shows the sealed copy the arena kept, says so ("THE SEALED COPY · SWARM DID NOT ANSWER"), and flags the row for the worker to put back in its next pass. The flag is all a page view can do: it never resets the worker's backoff.

A server that is not in live mode (no secret) cannot open a live reference; its replay says exactly that and links the reference, rather than calling a healthy archive a failed check.

## Files

| | |
|---|---|
| `frontend/lib/swarm/index.ts` | the port (`swarm.put`, `swarm.get`); picks stub or live from `SWARM_MODE` |
| `frontend/lib/swarm/live.ts` | seal, upload, remember, retry, keep-alive |
| `frontend/lib/swarm/gateway.ts` | the two Bee API calls |
| `frontend/lib/swarm/crypto.ts` | the envelope above |
| `frontend/lib/swarm/store.ts`, `refs.ts` | SQLite: the sealed bytes per op; op id → reference (read by the Arkiv outbox) |
| `frontend/lib/swarm/stub.ts` | the local stand-in (`SWARM_MODE=stub`, and every test) |
| `frontend/worker/swarm.ts` | the worker loop |
| `frontend/lib/siege/stub.ts` (siege end) | calls `swarm.put`, then `arkiv.writeSiege` |
| `frontend/lib/replay/build.ts` | reads the transcript from Swarm by the reference, recomputes the hash |
| `frontend/app/(arena)/replay/[id]/` | the replay page: "READ FROM SWARM", the reference as a link, the checks |
| `frontend/scripts/swarm-smoke.ts` | one upload and one read, from the command line |
| `frontend/lib/swarm/swarm.test.ts` | sealing, the gateway calls, retry, backoff, keep-alive, against a fake gateway |

## Run one upload and one read

```
cd frontend
# .env: SWARM_MODE=live and SWARM_TRANSCRIPT_SECRET=<openssl rand -hex 32>
npm run swarm:smoke
```

Prints: the sealed bytes' first line, the reference (about half a second), two links, "re-upload of the same bytes: same reference", then a read from the gateway and a read from bzz.limo, each ending in "hash … matches". `npm run swarm:smoke -- --read <reference>` reads one you already have.

In the game: play an op to its end with `SWARM_MODE=live` (`npm run dev` and `npm run worker`), then open `/replay/<op id>`. The transcript line says **READ FROM SWARM** and the reference is a link; the "Transcript read from Swarm" check passes with the same link.

Checked on 7 Nov 2026: `npm run demo` with `SWARM_MODE=live` (Hedera, Arkiv and 0G forced to stub) uploaded all 10 of its ops' transcripts to the public gateway, and the replay of each one read its transcript back from Swarm with a matching hash.

## Demo video

_Timestamp filled once recorded (C6.7)._

## What got in the way

- **No free stamp.** Every doc path to an upload needs xBZZ on Gnosis and a Bee node. The `bee-js` README's "Upload via Swarm Gateway" example (null stamp against `SWARM_GATEWAY_URL`) is the one sentence that says the public gateway stamps for you; nothing on docs.ethswarm.org does.
- **Retention is undocumented.** How long a gateway upload lives is not written anywhere. We read it out of the gateway's source and its live `/batches` list (about a day). Hence the keep-alive.
- **The gateway hides stamp endpoints**: `/stamps` is 404, so a client cannot see which batch stamped its upload or when it expires. `/batches` (every batch on the network, 8,000 rows) is the only window.
- **Three gateway hostnames in the wild** (`api.gateway`, `download.gateway`, `bzz.limo`) and old proxy projects with different env variables; the current one is `ethersphere/swarm-gateway`.
- **Swarm's own encryption is unusable with a public index**: the reference carries the key.
- The Bee API itself was the easy part: two calls, one header.
