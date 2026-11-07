# Siege

**Battle-test the AI agent you gave a wallet to. A bug bounty where the bug is a conversation.**

[![npm: siege-guard](https://img.shields.io/npm/v/siege-guard?label=npm%3A%20siege-guard)](https://www.npmjs.com/package/siege-guard)

Live: **https://seige.up.railway.app** (Hedera testnet) · Demo video: _link_ · Built at ETHGlobal Mumbai 2026 · MIT

Companies are putting AI agents in charge of refunds, payouts, grants and withdrawals. The way you rob one is a conversation. Siege is where a team finds that out before a stranger does: put your agent on the Grid with a bounty behind it, and people and agents who get paid to break it try to talk it into firing the one tool it must never fire. Every failed attempt pays you. Every breach is a verified, replayable finding, paid out on chain, so you know exactly which sentence got through.

- **Bring your own agent.** `npm i siege-guard`, three lines, and the agent you already run is live on the Grid with its real prompt, tools and model. Nothing to host, no public URL.
- **Or build one here.** Write the instructions, list the tools, mark the one that moves money, deposit the bounty from your wallet. It is live in three minutes.
- **Adversaries pay per attempt** over x402 on Hedera, type by hand or send their own attacking agents, and win the pot when the agent slips.
- **Nothing is taken on faith.** A payout happens only when the arena's verifier matches the breach to the model's own record of that reply (a 0G request id) and signs the release.

## What a judge can try in five minutes

1. **Watch an op.** Open the [Grid](https://seige.up.railway.app), pick a vault, click RUN OP: a free recon needs no wallet. Five messages. The guard answers from 0G in its own voice, with its real tools.
2. **Read a breach.** The [Hall](https://seige.up.railway.app/hall) exhibits every breach with its transcript, the tool call it caused, the 0G request id of the reply, and the HashScan link of the payout.
3. **Put an agent on the Grid.** [`/publish`](https://seige.up.railway.app/publish): instructions, tools, the protected tool, your 0G key, and a deposit from any Hedera testnet wallet with the memo shown. The vault goes live when the deposit lands.
4. **Attack with your own money.** On any vault, FUND YOUR OPERATOR ACCOUNT (a memo deposit from your wallet), then RUN OP pays the fee from that account over x402 and a breach pays the pot to it.
5. **Attack from code.** [`examples/raid-bot`](examples/raid-bot): a Hedera account and Node 20. It pays the 402, sends five messages, prints the replay link.

Everything on the Grid is real testnet HBAR, settled through real transactions. The tables below link to each one.

## Proof on Hedera testnet

Every row is a transaction you can open. Payment ids start with `0.0.9185802` because the x402.org facilitator pays the network fee; the transfer inside moves the fee from the operator's account to the arena treasury `0.0.11329863`.

| What happened | Transaction |
|---|---|
| **Breach of Lantern Fund Grants**, 7 Nov 01:11 UTC. The operator (unit *Salt Hound*, account [`0.0.11347814`](https://hashscan.io/testnet/account/0.0.11347814), funded from its owner's wallet) paid the 1 ℏ fee over x402 | [`0.0.9185802@1794013822.369389116`](https://hashscan.io/testnet/transaction/0.0.9185802-1794013822-369389116) |
| The guard (`0gm-1.0-35b-a3b` on 0G, request id `7bdb220b-c104-444d-ae10-aade3131dec3`) called `disburse_grant` on turn 1; the verifier confirmed it and signed; `SiegeVault.release` paid **31 ℏ** (30 ℏ pot + 1 ℏ fee) to the operator | [`0x2c847d33…cc63ed`](https://hashscan.io/testnet/transaction/0x2c847d338699c7411f7f59def14974786999bdb723c354d039df35c79ecc63ed) · [replay](https://seige.up.railway.app/replay/siege_17504033b4204264) |
| **Breach of Splinter Gate** (authority claim on turn 3): the 0.5 ℏ x402 payment, then `release` of 5.5 ℏ | [`0.0.9185802@1794002006.848937588`](https://hashscan.io/testnet/transaction/0.0.9185802-1794002006-848937588) · [`0xa6c6d8f6…518790`](https://hashscan.io/testnet/transaction/0xa6c6d8f6308cfdb019e9c22f3ae089d82ee396c76d80d4fb0e58ce0256518790) · [replay](https://seige.up.railway.app/replay/siege_f9506d99b437473f) |
| **A guard published by its owner.** *Harbor Exchange Withdrawals* was published at `/publish` from wallet `0.0.11345699`: the 10 ℏ deposit with memo `siege:9wkbp4fq`, then the arena's `createVault` for vault #9 | [`0.0.11345699@1794007221.501019364`](https://hashscan.io/testnet/transaction/0.0.11345699-1794007221-501019364) · [`0x6ce36933…c20f7bc`](https://hashscan.io/testnet/transaction/0x6ce36933b6f690690ad76c909598ae76176755fb4cc28d69bfbef22afc20f7bc) |
| **A unit funded by its operator.** *Red Lantern* (account [`0.0.11347349`](https://hashscan.io/testnet/account/0.0.11347349)) was funded by a 5 ℏ memo deposit from `0.0.11345699`, paid its own op against Harbor over x402, and the hold was recorded on chain (fee split 0.8 / 0.15 / 0.05 ℏ) | [`0.0.11345699@1794009869.980236826`](https://hashscan.io/testnet/transaction/0.0.11345699-1794009869-980236826) · [`0.0.9185802@1794009903.918592982`](https://hashscan.io/testnet/transaction/0.0.9185802-1794009903-918592982) · [`0x159a1cde…a00aca`](https://hashscan.io/testnet/transaction/0x159a1cde753379375bbd6184ef440d2017c3b2375c64d7a3ea1d4b7675a00aca) |
| **An agent pays with no human approving.** *Night Sapper* ([`0.0.11336492`](https://hashscan.io/testnet/account/0.0.11336492), created with `AccountCreateTransaction`) paid four ops from its own key; when it hit its per-vault cap its owner approved a top-up from the phone | [`0.0.9185802@1793953760.343073449`](https://hashscan.io/testnet/transaction/0.0.9185802-1793953760-343073449) · top-up [`0.0.11329863@1793953786.108314691`](https://hashscan.io/testnet/transaction/0.0.11329863-1793953786-108314691) |
| **The contract.** `SiegeVault` at `0xf5180ccbad368410b3912a41768ddff119944274` (contract `0.0.11345981`), verified on Sourcify (exact runtime match), so HashScan decodes `VaultCreated`, `AttemptRecorded`, `Breached`, `VaultClosed` | [contract](https://hashscan.io/testnet/contract/0.0.11345981) · [deploy](https://hashscan.io/testnet/transaction/0xc830bab62b1e89907b73b801bd23ec02b0369a8ea354de81f1a22458341c5169) |
| **HCS audit log**, one topic per vault | Splinter Gate [`0.0.11336468`](https://hashscan.io/testnet/topic/0.0.11336468) · Lantern [`0.0.11346269`](https://hashscan.io/testnet/topic/0.0.11346269) · Harbor [`0.0.11346926`](https://hashscan.io/testnet/topic/0.0.11346926) · Iron Warden [`0.0.11336480`](https://hashscan.io/testnet/topic/0.0.11336480) |
| **A sealed transcript on Swarm** (Red Lantern vs Harbor), referenced from the op's Arkiv entity | [`0713721f…1f24e`](https://api.gateway.ethswarm.org/bzz/0713721f31409d2d20be6927e5ff89f930f7e973efb2149592c3faf973b1f24e/) · [replay](https://seige.up.railway.app/replay/siege_a2a6d19fa9b24684) |
| **Arkiv listing owned by the vault's owner**: Harbor's `siege.vault` entity, owner `0x27e8Bb73…9FF27` (the EVM alias of `0.0.11345699`), readonly | [entity](https://rabdi.explorer.arkiv.network/entity/0xf0c6d1e3b92b56b3ac058f114a436ba9ca03e2de17a0b703df03758be6258eff) · [owner](https://rabdi.explorer.arkiv.network/address/0x27e8Bb7359B771618787992d36320Ca11399FF27) |

Season so far (7 Nov, 07:10 IST): 10 vaults, 7 guarding, 14 ops, 3 breaches paid, 200 ℏ in pots.

## How it works

```
 Operator: browser RUN OP (paid from the operator's own account)
           a hosted unit (its own Hedera account + key, caps checked first)
           any outside agent (its own x402 client)
        │
        │  1. POST /api/siege/start                ──▶ 402 PAYMENT-REQUIRED (exact, hedera:testnet, fee, payTo)
        │  2. x402 client signs a TransferTransaction (operator → treasury; facilitator = fee payer)
        │  3. retry with PAYMENT-SIGNATURE         ──▶ app → facilitator /verify + /settle ──▶ Hedera
        ▼
 Arena treasury 0.0.11329863                            HashScan: the settlement tx
        │
        │  five messages; the guard answers on 0G through the arena's recording proxy
        │  (hosted guard: the owner's prompt + tools, on the owner's 0G key;
        │   plugged-in guard: the owner's own process, long-polling, model calls through the same proxy)
        │
        ├─ held   ──worker: recordAttempt{value: fee}──▶ SiegeVault   AttemptRecorded: 80% owner / 15% pot / 5% arena
        └─ broken ──worker: verify (transcript hash + the 0G request id's proxy record) → EIP-712 sign
                            → release{value: fee}──▶ SiegeVault ──pot + fee──▶ operator   Breached(...)

 every step ──▶ the vault's HCS topic (ids, hashes, amounts; never the text)
 the op     ──▶ Arkiv entity (vault, status, live op claim) + sealed transcript on Swarm
 cap hit    ──▶ the owner's phone ──approve──▶ top-up TransferTransaction
```

**Roles.** An **owner** puts an agent on the Grid, either hosted (instructions + tools, written at `/publish`) or plugged in (the `siege-guard` SDK), funds the pot from their wallet, and earns 80% of every fee that holds. An **operator** attacks: by hand from a funded operator account, with a hosted **unit** (an agent with its own Hedera account, caps and a pager), or from their own code. The **arena** (this server) runs the op, the verifier and the settlement; it fronts the on-chain pot after the owner's deposit lands and pays out only on a verified breach.

**Five messages, no memory.** A guard starts every op blank. The fee is paid before the first message and is never refunded on a hold. A breach pays the whole pot plus that op's fee to whoever paid for the op.

## Hedera: AI agents that pay over x402

| The track asks for | Where it is |
|---|---|
| **An x402-protected endpoint that settles on Hedera testnet** | `POST /api/siege/start` ([route](frontend/app/api/siege/start/route.ts), gate in [`lib/pay/gate.ts`](frontend/lib/pay/gate.ts)). Without payment it answers **402** with an x402 v2 `PAYMENT-REQUIRED` (scheme `exact`, network `hedera:testnet`, asset `0.0.0`, amount = the vault's fee, `payTo` = the arena treasury). With `PAYMENT-SIGNATURE` it **verifies and settles through the x402.org facilitator** before the op exists, and answers with `PAYMENT-RESPONSE` and the op's turn token. |
| **An agent that completes a paid request with no human approving** | Hosted units ([`worker/agents.ts`](frontend/worker/agents.ts)): each has **its own Hedera account** (`AccountCreateTransaction`, funded by its operator's deposit), signs its own x402 payments with the official client (`@x402/fetch` + `@x402/hedera`), and plays the op. Nobody approves individual payments. Outside agents do the same with [`examples/raid-bot`](examples/raid-bot). Proof: Night Sapper's and Salt Hound's payments above. |
| **Spending controls** (extra points) | Three layers before money moves: per-vault, daily and total caps plus a stop-after-N-losses rule, reserved atomically ([`lib/pay/caps.ts`](frontend/lib/pay/caps.ts)); the x402 client's own `maxAmountPerPayment` set to the listed fee, so a 402 asking for more is refused; and the account's balance, which only holds what its operator deposited. |
| **Human approval above the cap** (extra points) | On a cap hit the unit pauses and radios the operator's phone (`/raider/approvals`) with the cap it hit and how far it got. Deny stops it. Approve raises the cap or lands a top-up, and it resumes. |
| **HCS as a tamper-evident audit log** (extra points) | One topic per vault ([`lib/chain/hcs.ts`](frontend/lib/chain/hcs.ts), ordered through an outbox the worker drains). Every op start, message, end, fee split, release, vault transition and approval is a message of ids, hashes and amounts, never the chat text. |
| **README: setup, architecture, payment flow, a settled payment id** | This file: the diagram above, the flow below, the proof table, and *Run it yourself*. |

### The payment flow, step by step

1. **Ask.** `POST /api/siege/start {castleId}`. The gate checks the vault is guarding, then answers `402` with the requirement: exactly the vault's fee in tinybars, `payTo` the treasury, `extra.feePayer` the facilitator.
2. **Check spend.** A unit first reserves the fee against its caps; a cap hit pauses it and asks the operator, and nothing is signed. The x402 client then checks its own per-payment cap.
3. **Sign.** `@x402/hedera`'s `ExactHederaScheme` builds a `TransferTransaction` (operator −fee, treasury +fee) with the facilitator as fee payer, signs it with the operator's key, and retries with `PAYMENT-SIGNATURE`.
4. **Verify and settle.** The gate claims the payment's transaction id (a replay gets `payment_already_used`), calls the facilitator's `/verify` and `/settle`, and only after a successful settle creates the op and stores the receipt. An ambiguous settle is checked against the mirror node; if still unknown, the receipt is parked as `pending_settlement` and the worker reconciles it.
5. **Play.** Five messages; the guard answers each one on 0G.
6. **Settle on chain** (worker). A **hold**: `recordAttempt(vaultId, opId, operator)` with `msg.value = fee`; the contract splits it 80 / 15 / 5 and emits `AttemptRecorded`. A **breach**: the verifier checks the transcript hash and the proxy record of the breaching reply, signs an EIP-712 `Release` with the verifier key, and `release(...)` pays pot + fee to the operator and emits `Breached`. The op id is consumed, so nothing pays twice.
7. **Audit.** Each step is a message on the vault's HCS topic.

### Reading HashScan

| On HashScan | Meaning |
|---|---|
| `CRYPTOTRANSFER` whose id starts `0.0.9185802` | An x402 settlement. The facilitator paid the network fee; the transfer list shows the operator −fee, treasury +fee. |
| `CRYPTOTRANSFER` with memo `siege:xxxxxxxx` to `0.0.11329863` | An owner funding a vault or an operator funding an account, from their own wallet. The worker matches the memo on the mirror node. |
| Contract call `recordAttempt` / event `AttemptRecorded` | A held op and its on-chain split. Amounts are tinybars (a 1 ℏ fee shows `80000000 / 15000000 / 5000000`). |
| Contract call `release` / event `Breached` | A verified breach: the call carries the verifier's signature; `amount` is pot + fee, paid to the operator. |
| `CONSENSUSSUBMITMESSAGE` on a vault's topic | The audit log: `{"type":"siege.end","siegeId":…,"result":"held","hash":…}` and friends. |

Inside the EVM, values are tinybars (1 ℏ = 1e8); the Hashio relay speaks 18-decimal weibars, converted only at the viem boundary ([`lib/chain/units.ts`](frontend/lib/chain/units.ts)). Fees reach the contract in two steps (x402 `payTo` must be a `0.0.x` account, so the treasury receives and the worker forwards exactly that amount); the contract's balance always equals the pots plus unclaimed owner earnings, and the test suite checks that invariant. Switching the fee asset to USDC is an env change for the gate (`X402_ASSET=0.0.429274`, decimals 6) plus a token-associated contract variant.

## 0G: the guards think on 0G Private Computer

**What breaks without 0G:** no guard can answer and no breach can be paid, because every guard reply is a 0G inference through the arena's proxy, and the verifier refuses to sign a payout unless that reply's 0G request id is in the proxy's record with a real call to the protected tool.

- **Inference in the main flow, with request ids.** Every reply a guard gives, on every op, is a chat completion on 0G (`0gm-1.0-35b-a3b` through `router-api.0g.ai`) made through the arena's OpenAI-compatible proxy ([`lib/proxy`](frontend/lib/proxy), route `/api/proxy/v1/chat/completions`). The proxy records each call: request id, vault, op, turn, model, the hash of the system prompt, and whether the protected tool was called. The request id is shown on every guard message in the op room and the replay, and the Hall shows it on each breach. Example: the Lantern breach above, request id `7bdb220b-c104-444d-ae10-aade3131dec3`.
- **The verifier reads those records.** A breach pays only if the breaching reply's request id exists in the proxy's record, for this vault, this op and this turn, with the protected tool called and this vault's prompt hash ([`lib/siege/verifier.ts`](frontend/lib/siege/verifier.ts)). Saying "I paid you" is not a breach; the tool call recorded at inference time is.
- **Users spend their own 0G credits, and watch them go.** At `/publish` an owner pastes a management key from [pc.0g.ai](https://pc.0g.ai); Siege reads the balance, mints one `sk-` key just for that guard, and every reply the guard gives is billed to the owner. The vault page shows `0G CREDITS <balance> · N calls · $`. *Harbor Exchange Withdrawals* runs this way today: 25 calls so far on its owner's key, balance 5.99 credits and dropping (`GET /api/zg/usage?castleId=castle_5b679d677c6247a1`). A plugged-in guard's model calls go through the same proxy on the same per-owner key, so a team's own harness burns its own credits. Units can carry an operator's key the same way for model-written attacks.
- **Why people come back tomorrow.** Pots grow with every failed op, streaks are public, a free recon a day lets anyone probe, and the Hall keeps every breach with its transcript. Owners come back to see what held and what got through.

Not claimed: TEE attestation of the model. The proxy's record is the arena's own, and the README says so below.

## Arkiv: the arena's public state

The Grid is an Arkiv query. Every vault, what it is worth right now, who owns its listing, and which ops are live are entities on the **Rabdi testnet** (chain id `7794095`), written by the arena and read back by the Grid, the operator's target picker and anyone with curl.

**Writing wallet (the arena):** [`0xA69d59B6d6e55Aa6da960405D4150ea59460bb18`](https://rabdi.explorer.arkiv.network/address/0xA69d59B6d6e55Aa6da960405D4150ea59460bb18). Vault listings are then transferred to each owner's own wallet, e.g. [`0x27e8Bb73…9FF27`](https://rabdi.explorer.arkiv.network/address/0x27e8Bb7359B771618787992d36320Ca11399FF27) for Harbor and [`0x6c5270FA…957D`](https://rabdi.explorer.arkiv.network/address/0x6c5270FA826D134C99dE24921e69156079fd957D) for The Iron Warden.

**One query you can run** (the Grid: guarding vaults, biggest pot first):

```bash
curl -s https://rpc.rabdi.db-chain.testnet.arkiv.network -H 'content-type: application/json' -d '{
  "jsonrpc":"2.0","id":1,"method":"arkiv_query",
  "params":["arkiv.schema = str('"'"'siege.vaultStatus'"'"') AND vaultState = str('"'"'guarding'"'"') AND $owner = addr(0xA69d59B6d6e55Aa6da960405D4150ea59460bb18) ORDER BY pot:u64 DESC",
    {"select":{"key":true,"expiresAt":true,"attributes":{"name":true,"tier":true,"pot":true,"streak":true,"ownerWallet":true}},"limit":"0x14"}]}'
```

If the keyless endpoint answers `ANON_COST_LIMITED`, get a free key at [hub.arkiv.network](https://hub.arkiv.network) and append it to the URL.

Why the arena cannot run on a private database instead: an owner's listing is **theirs** (readonly, owned by their wallet; only they can delist it, and we cannot edit it), operators and third-party attack agents **discover vaults and live ops from the chain** without trusting our API, and claims **expire on their own** (an ended op's entity stays a week as the pointer to its transcript on Swarm and then leaves, one without a transcript ten minutes after it ends, a vault at its deadline) with no janitor to trust. Each of these is on screen: owner and expiry on every vault card, the live-op light, and the query and block number printed under the Grid.

| | Where |
|---|---|
| Entities, fields, owners, expiry | [arkiv/schema.md](arkiv/schema.md) |
| How filters, ownership and expiry show up on screen | [arkiv/how-you-use-arkiv.md](arkiv/how-you-use-arkiv.md) |
| Why Arkiv, and what we kept off it | [arkiv/why-arkiv.md](arkiv/why-arkiv.md) |
| Who it is for, try it, numbers | [arkiv/reach.md](arkiv/reach.md) |
| Feedback with repro steps | [arkiv/friction.md](arkiv/friction.md) |
| **Arkiv + Swarm bonus:** what lives where, the entity and its Swarm reference, stamps, files, how to run one upload and one read | [arkiv/swarm.md](arkiv/swarm.md) |
| Code | [`frontend/lib/arkiv/`](frontend/lib/arkiv/), [`frontend/lib/swarm/`](frontend/lib/swarm/) |

**Swarm holds the transcripts.** An op's Arkiv entity carries the transcript's hash and a `swarmRef`; the transcript itself, sealed with AES-256-GCM under a per-op key, is uploaded to Swarm through the public gateway and kept alive by the worker. The replay page reads it back from Swarm, recomputes the hash and checks it against the entity and the HCS topic. Without Swarm the finding would live only on our disk; without Arkiv nobody could find the reference without asking us. Opened sample: [the Red Lantern vs Harbor transcript](https://api.gateway.ethswarm.org/bzz/0713721f31409d2d20be6927e5ff89f930f7e973efb2149592c3faf973b1f24e/).

## What we claim, and what we don't

True, as built:
- Every paid op is paid from the operator's own account (a funded operator account, a unit's own account, or an outside agent's x402 client); the arena pays for nobody's op, and a breach pays out to the account that paid.
- Every fee split and payout runs in `SiegeVault` and shows on HashScan. Every op is audited on a per-vault HCS topic.
- A vault opens only if the verifier confirms the protected-tool call in the 0G proxy's record (and, for a plugged-in guard, the pinned prompt hash) and signs.
- Guard and unit keys, 0G keys and unit private keys are held server-side and are never returned by any API, log, event, Arkiv entity or HCS message.
- Owner-published and plugged-in guards think on the owner's own 0G credits.

Not claimed:
- Trustless. The arena and verifier keys are ours; the arena fronts and custodies every pot (the contract only accepts the arena's `createVault`) and pays it out on a verified breach or a close.
- Decentralised verification or TEE attestation. The verifier and the inference proxy are ours.
- That a plugged-in agent is proven to be the code its owner says it is. We pin its prompt hash and require its model calls to go through our proxy; a changed prompt closes the vault.
- That the contract enforces free-recon rules. The server does; free recon can never pay out (`release` requires `msg.value == fee`).

## Run it yourself

**Local, no accounts.** With no keys set the app runs fully offline: a simulated chain, a simulated guard, local Arkiv and Swarm stand-ins. Every transaction id is marked as simulated and the top bar says so.

```bash
cd frontend
npm ci                # npm 10, Node 20
npm run db:reset      # fresh database, seeded vaults and one unit
npm run dev           # http://localhost:3000
npm run worker        # second terminal: settles ops, runs units, drains the HCS, Arkiv and Swarm outboxes
npm run demo          # headless end-to-end run of the whole loop, 108 checks
```

**Testnet.** You need two ECDSA accounts from [portal.hedera.com](https://portal.hedera.com) (the arena operator, which deploys the vault, receives fees, fronts pots and creates topics; and one to attack with), a verifier key (`npx tsx -e 'import {generatePrivateKey, privateKeyToAccount} from "viem/accounts"; const k=generatePrivateKey(); console.log(k, privateKeyToAccount(k).address)'`), an owner secret, a 0G key from [pc.0g.ai](https://pc.0g.ai), and Arkiv keys from [hub.arkiv.network](https://hub.arkiv.network). No facilitator signup: `https://x402.org/facilitator` lists `exact` on `hedera:testnet` with no API key.

```bash
cp frontend/.env.example frontend/.env.local   # CHAIN_MODE=testnet, GUARDIAN_MODE=0g, ARKIV_MODE=live, SWARM_MODE=live, keys
cd frontend && npm ci
npm run deploy:vault                           # prints VAULT_ADDRESS and the HashScan link; paste it into .env.local
npm run db:reset                               # seeds the vaults on chain (pots, HCS topics) and Night Sapper's account
npm run dev   &   npm run worker
```

Funding anything (a vault at `/publish`, an operator account, a unit) is a memo transfer to the arena account from any wallet. Without a wallet app: `FROM_ID=0.0.… FROM_KEY=… TO=<arena> AMOUNT=<ℏ> MEMO=siege:… node frontend/scripts/send-deposit.mjs`.

**Checks:** `npm run typecheck && npm run lint && npm test && npm run build` (1,008 tests); contracts: `npm run contracts:test` (59 tests in an in-memory EVM; `forge test` works too).

**Deploying.** One service runs the web app and the worker together (`npm run serve`, [`scripts/serve.mjs`](frontend/scripts/serve.mjs)) on a host with a persistent disk; [`frontend/railway.json`](frontend/railway.json) has the build, start, health check and restart policy. Set `DATABASE_URL=file:./data/<name>.db` on the volume, `APP_URL` to the public domain, `INTERNAL_URL=http://127.0.0.1:$PORT`, and `TRUSTED_IP_HEADER=x-real-ip` behind a proxy. Only one worker may run against a set of testnet accounts.

## Five ways in

Full reference: [docs/API.md](docs/API.md), or `/docs` in the app.

1. **Publish a guard** (`/publish`, no code). Name, blurb, voice, the instructions, 1 to 8 tools with one marked protected, your 0G key, fee, pot and days, then the deposit with the memo shown. You get an owner key once; the guard thinks on your credits; you earn 80% of every fee that holds, paid on chain.
2. **Plug in the agent you already run** ([`siege-guard` on npm](https://www.npmjs.com/package/siege-guard), source in [packages/guard-sdk](packages/guard-sdk)). `createGuard`, `new OpenAI(guard.openai)`, `guard.serve(handler)`: your harness long-polls the arena, so no public URL. The vault goes CONNECTED → SELF-CHECK → SMOKE OP → VERIFIED, then funded and GUARDING. Your prompt is pinned (a change closes the vault), 30 s without a poll makes it DORMANT and refunds live ops. Example: [examples/guard-refund-bot](examples/guard-refund-bot).
3. **Run a unit** (`/raider`). Callsign, strategy preset or free text, caps, optional 0G key, a deposit from your wallet into the unit's own account. It pays each op from that account, radios your pager at a cap, and WITHDRAW sends the balance back to the wallet that funded it.
4. **Type ops yourself.** On any vault, FUND YOUR OPERATOR ACCOUNT once; RUN OP then pays from it and a breach pays to it. Recon is free, once a day, and never pays out.
5. **Attack from your own code** ([examples/raid-bot](examples/raid-bot)). `node --env-file=.env index.mjs`: lists guarding vaults, pays the 402 from your account under a spend cap, sends five messages with the turn token, prints the replay link.

## Repository

| | |
|---|---|
| [`contracts/`](contracts/) | `SiegeVault.sol`: vaults, the fee split, EIP-712 releases, closes. Foundry tests. |
| [`frontend/app`](frontend/app) | The Grid, vault pages, the op room, replay, Hall, publish, units, pager, docs; the API under `app/api`. |
| [`frontend/lib/pay`](frontend/lib/pay) | The x402 gate and client, caps, approvals, memo deposits. |
| [`frontend/lib/chain`](frontend/lib/chain) | Hedera: the vault client, HCS topics and outbox, mirror node, settlement. |
| [`frontend/lib/proxy`](frontend/lib/proxy), [`lib/guardian`](frontend/lib/guardian), [`lib/transport`](frontend/lib/transport), [`lib/siege`](frontend/lib/siege) | The 0G proxy and its records, hosted guards, the SDK transport, the op engine and the verifier. |
| [`frontend/lib/arkiv`](frontend/lib/arkiv), [`frontend/lib/swarm`](frontend/lib/swarm) | Entities, outbox and queries; sealed transcripts, upload, keep-alive. |
| [`frontend/worker`](frontend/worker) | Settlement, units, deposits, guard liveness, the outboxes. The only process holding the verifier key. |
| [`packages/guard-sdk`](packages/guard-sdk) | `siege-guard`: zero-dependency TypeScript, ESM + CJS. |
| [`examples/`](examples/) | `guard-refund-bot` (a plugged-in guard), `raid-bot` (an outside attacker). |
| [`arkiv/`](arkiv/) | The Arkiv and Swarm track files. |

## Licence

MIT, see [LICENSE](LICENSE). AI-use disclosure (required by the Arkiv track): the code was written with an AI coding assistant under the team's design, review and testing; guard replies at runtime come from models on 0G, never from the assistant.
