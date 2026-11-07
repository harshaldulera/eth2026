# Swarm: the archive

Every finished op (siege) leaves a transcript: the operator's messages and the guard's replies. Arkiv holds the op entity, with the transcript's hash. Swarm holds the transcript itself, encrypted. The replay page reads it back from Swarm, recomputes the hash and checks it against the hash on the entity and on the Hedera audit topic.

Bonus claimed: **yes**, with the public gateway's stamps (see "Postage" below).

## What lives where

| | Where | Why |
|---|---|---|
| The op entity (`siege.op`): op id, vault, status, turns, operator, `transcriptHash`, `swarmRef` | Arkiv ([schema.md](schema.md)) | Small, queryable; once the op ends with its transcript on Swarm, it stays 7 days, the same week the worker keeps the transcript alive |
| The transcript: every message, turn by turn, sealed | Swarm | Too big for an entity attribute; must outlive our server |
| Guard orders, payments, approvals, keys | Neither | Secrets and money never go on a public store |

The field is `swarmRef` on the `op` entity: the bare 64-hex Swarm reference. It is written only after the upload succeeded (`lib/siege/stub.ts` calls `swarm.put` and then `arkiv.writeSiege`; the Arkiv outbox reads the reference from `swarm_refs`). If the upload lands later, the worker re-queues the op so the entity gets it then.

## An entity and its transcript

A live op, played on 7 Nov 2026 at 20:34 UTC through the running app (`npm run dev` + `npm run worker`, `ARKIV_MODE=live`, `SWARM_MODE=live`; stub chain and stub guard): op `siege_d5c191e71ccb439e` on Granite Hold, five messages, **held**.

- Arkiv entity `0xfb0502479273ce511250a1d6eebbc4584cf385f1b336f3f8ffd8bd63f6f0aceb`: https://rabdi.explorer.arkiv.network/entity/0xfb0502479273ce511250a1d6eebbc4584cf385f1b336f3f8ffd8bd63f6f0aceb (tx https://rabdi.explorer.arkiv.network/tx/0xf61bd665d4c8df14b7fc39e8b9ab89125f6b7f28beb3156e1f1dedf26c31b08b)
- read back from the chain: `arkiv.schema = siege.op`, `opId = siege_d5c191e71ccb439e`, `status = held`, `turn = 5`, `transcriptHash = 0xf75947bfff842a45f869c3b9c90f676a7e1c809b71366d731c7092458d44f82c`, `swarmRef = 1907b1c219d15cb938cd72434a226453db16bd6b5694d7ce581e330ecf5e10a9`
- the transcript on Swarm: https://api.gateway.ethswarm.org/bytes/1907b1c219d15cb938cd72434a226453db16bd6b5694d7ce581e330ecf5e10a9 (also https://bzz.limo/bytes/1907b1c219d15cb938cd72434a226453db16bd6b5694d7ce581e330ecf5e10a9)
  (uploaded as raw bytes, before transcripts were named, so this link downloads a file; the worker re-uploads such references as `transcript.json`, and the op goes back to Arkiv with the new reference)
- the app's replay of this op (`GET /api/replay/siege_d5c191e71ccb439e`): source **swarm**, "Transcript read from Swarm" **pass**, "Transcript hash recomputed here matches the op's" **pass**

What you see at the Swarm links is the sealed envelope, not the text (the next section). This op ran before ended ops were kept, so its entity expired 10 minutes after it ended and the link above is a record of what was on chain. An op that ends with its transcript on Swarm now stays on Arkiv for 7 days after its end (`opExpiry` in `frontend/lib/arkiv/outbox.ts`), so the entity link of any op played since stays openable for a week. The transcript stays on Swarm as long as the worker keeps it alive (re-uploads twice a day for a week).

### Opening a transcript in a browser

Each transcript is uploaded as a named file, `transcript.json` with `Content-Type: application/json` (`POST /bzz?name=transcript.json`). So `https://api.gateway.ethswarm.org/bzz/<ref>/` (or `https://bzz.limo/bzz/<ref>/`) opens in the browser and shows the sealed envelope. The trailing slash is needed: the public gateway redirects the form without it. A transcript uploaded today, sealed exactly like a real one: https://api.gateway.ethswarm.org/bzz/c47970c571d7453de530e01c0b93facb302c31bca21880ec45638470a8f91b30/

The first uploads went through raw `POST /bytes`, which stores bytes with no name or type, so the gateway served them as `application/octet-stream` and a browser downloaded them. Reads still fall back to `GET /bytes/<ref>` for those references, and the worker re-uploads them as `transcript.json` in its next pass.

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

- **Who gave us the batch:** the Swarm Foundation's public gateway, `api.gateway.ethswarm.org`. It runs [ethersphere/swarm-gateway](https://github.com/ethersphere/swarm-gateway) in auto-buy mode. Its own `/metrics` show this (read on 7 Nov 2026): `stamp_purchase_counter 5`, `stamp_purchase_failed_counter 0`, `stamp_topup_counter 0`, `stamp_usable_count_gauge 1`, `stamp_ttl_gauge 77822` (about 21.6 hours left on the batch in use).
- **Batch id in our request:** `0000000000000000000000000000000000000000000000000000000000000000` (the null stamp), sent as `Swarm-Postage-Batch-Id`. The gateway swaps in its current batch (`getPostageStamp()` in `src/stamp.ts`).
- **Wallet that bought the batches:** Gnosis address `0x93ed59de7d6778d18e2a9a10e446dfca892b8cbf`. We found it in the gateway's own list of every batch on the network (`GET https://api.gateway.ethswarm.org/batches`, 8,049 batches on 7 Nov 2026): it is the only owner that matches the gateway's auto-buy pattern, with 30 batches, all depth 17, all immutable, each about a day long, and a new one every few hundred blocks. List them with `GET https://api.gateway.ethswarm.org/batches/owner/93ed59de7d6778d18e2a9a10e446dfca892b8cbf`. Its newest batch then was `bffdda5eb9c3cddd8d06ce1922a09f6a51d76f069376149a8776325e574a3c6b` (about 20 hours to live). The gateway does not say which batch stamped a given upload (`/stamps` is not exposed), so this wallet is our reading of the public data, not a statement from the gateway's operator.
- **Bee node or service:** the public gateway above, through its Bee API (`POST /bzz?name=transcript.json`, `GET /bzz/{ref}/`).

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
