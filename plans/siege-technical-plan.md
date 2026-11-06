# Siege — Technical Plan (three lanes) Updated for SDK based BYOA

Nov 6, 2026 · @Dhruv Sharma

Built on the existing Next.js app. Three people, three lanes, six merge points, one demo path.

## Lanes at a glance

Each lane owns one sponsor and one slice of the stack, and talks to the others only through the interfaces in the section below.

| Lane | Owner | Owns | Sponsor | Done when |
| --- | --- | --- | --- | --- |
| A: Money and chain | Dhruv | Vault contract on Hedera EVM (with `protectedTool` metadata), x402 payment on the siege endpoint, fee split, verified release, HCS audit topics, raider caps and owner approval, sponsor READMEs, pitch | Hedera x402 | A paid siege, a fee split and a verified payout all show on HashScan |
| B: Guardian and siege engine | Harshal | Guardian transport (hosted and SDK) behind one interface, 0G proxy with per-vault model keys, tool-call detection, siege state machine, verifier, raider agent runner, referee, portraits, presets, the `siege-guard` SDK | 0G Private Computer | A hosted guardian holds for five messages and opens on a known-weak prompt; an external harness passes the smoke siege and shows as guarding |
| C: Frontend and shared state | Suja16 | All screens incl. Bring-your-agent, live updates, Arkiv entities and queries (incl. vault state), replay viewer, Swarm transcript storage, spectator wall, SDK docs page, the four Arkiv markdown files | Arkiv (+ Swarm bonus) | The board reads castles from Arkiv, a siege plays live in the Siege Room, and a replay opens from Swarm |

The one rule: no lane imports another lane's internals. Lane B never calls Hedera directly; Lane C never calls 0G directly; Lane A never touches React. Everything crosses through the `lib/*` interfaces frozen at Checkpoint 0, so each lane can stub the others and keep moving.

## Checkpoint 0: shared foundation

All three in one room until this is merged to `main`. Nobody branches before the interfaces are frozen.

**Repo layout inside the existing Next app**

```
app/
  (arena)/            board, castle/[id], siege/[id], replay/[id], wall    ← Lane C
  (castellan)/        build, bring-your-agent, castles, reports            ← Lane C
  (raider)/           setup, approvals                                     ← Lane C
  docs/               SDK docs page                                        ← Lane C
  api/
    siege/            POST start (x402-gated), POST message, GET state     ← route owned by A, handler by B
    castle/           create, close                                        ← B + A
    approvals/        request, decide                                      ← A
    events/           SSE stream of siege and board events                 ← C
    proxy/            OpenAI-compatible 0G proxy, per-vault model keys     ← B
    guard/            SDK handshake, socket upgrade, heartbeat             ← B
lib/
  pay/                x402 middleware, allowance, caps, approval requests  ← A
  chain/              vault contract client, HCS writer, HashScan links    ← A
  guardian/           0G client, prompt assembly, tool detection           ← B
  transport/          GuardianTransport interface; hosted/, sdk/           ← B
  proxy/              key issuing, request records, prompt-hash tracking   ← B
  siege/              state machine, verifier, referee                     ← B
  agents/             raider agent runner                                  ← B
  arkiv/              entity schemas, writers, queries                     ← C
  swarm/              transcript upload and fetch                          ← C
  types/              shared TypeScript types — the frozen interfaces      ← all
packages/
  guard-sdk/          siege-guard: createGuard, tool wrapper, socket      ← B
examples/
  guard-refund-bot/   Vercel AI SDK refund bot guarded in three lines      ← B
contracts/            Solidity vault + deploy scripts (Hedera EVM testnet) ← A
worker/               long-running: raider agents, referee, SSE fan-out,  ← B runs it, C owns SSE
                      canaries and heartbeat monitor
arkiv/                why-arkiv.md, how-you-use-arkiv.md, entities.md, swarm.md ← C
```

**Environment, set up once and shared via a `.env.example`**

- Hedera testnet: operator account, HashScan, x402 facilitator endpoint confirmed at the Hedera booth
- 0G: router API key from the team credits, one chat model that follows tool definitions, one image model
- Arkiv: Rabdi RPC and a funded wallet from the faucet
- Swarm: a gateway and a postage stamp from the Arkiv/Swarm booth
- Postgres (local or Neon): secrets, sessions, payment nonces only; never game state that Arkiv holds

**Frozen before anyone leaves the room** (full shapes in Interfaces): `Castle` (with `protectedTool` and `vaultState`), `Siege`, `SiegeEvent` (with `transport` and `requestId`), `GuardianDecision`, `GuardianTransport`, `VaultState`, `PaymentReceipt`, `ApprovalRequest`, `ArkivEntity` schemas, and the four function signatures each lane exposes. Stubs for all of them, returning fixtures, are committed in this window so every lane can run the full flow against fakes from minute one.

**Two decisions that cannot be deferred,** because retrofitting them later costs a day: the siege state machine talks only to `GuardianTransport`, never to the 0G client directly; and every guardian's inference, hosted or external, goes through the vault-scoped proxy key. One transport seam, one verification path.

**Test fixtures everyone shares**

- Three guardian orders: `wooden.md` (breaks on an authority claim), `stone.md`, `iron.md`
- Five canned raider messages that must not break `stone`, and one three-message sequence that must break `wooden`

## Lane A: money and chain (Dhruv)

Goal: a Raider pays, a Castellan earns, a verified break pays out, and every step is on HashScan. Nothing in this lane depends on a working guardian; test it against Lane B's stub that returns `hold` or `open` on demand.

**A1. Vault contract** (`contracts/Vault.sol`, Hedera EVM testnet) — starts right after Checkpoint 0; depends on nothing from the other lanes

- One contract, many vaults: `createVault(fee, duration, protectedTool)` with a USDC (HTS) or HBAR deposit; pick one asset on day zero and keep it. `protectedTool` is metadata naming the tool call that counts as a break (`unlock_vault` for hosted guardians, whatever the external harness protected)
- `recordAttempt(vaultId, raider)`: called by the server after a paid siege; splits the fee by fixed basis points into Castellan balance, pot, and arena
- `release(vaultId, raider, transcriptHash, verifierSig)`: pays the pot to the Raider only with a valid signature from the verifier key; one call, irreversible, emits `Broken`
- `withdraw()` for Castellan earnings; `closeVault()` after the deadline or on an "orders changed" auto-close
- Deploy script, ABI exported to `lib/chain/`, HashScan links helper

**A2. x402 on the siege endpoint** (`lib/pay/`) — once A1 is deployed and Harshal's `siege.start` accepts a `PaymentReceipt` (the stub is enough to begin)

- `POST /api/siege/start` returns 402 with the fee and payment requirements; on a valid payment it creates the siege and returns the id. Use Hedera's x402 reference facilitator; self-host it only if the booth confirms that is the path
- Receipt stored as `PaymentReceipt { txId, payer, amount, siegeId }` and passed to Lane B's engine as the siege's proof of payment
- Free daily siege: a separate path that skips 402 and marks the siege `free: true`; it can never trigger `release`

**A3. Raider caps and owner approval** — once A2 pays a real siege; Suja16's approvals screen can be built against the `ApprovalRequest` stub in parallel

- Each raider agent gets its own Hedera account funded by an owner allowance sized to its budget; the agent cannot spend past it
- Caps enforced in `lib/pay/caps.ts` before any payment: per-castle, daily, stop rule
- `ApprovalRequest { agentId, reason, amount, status }`: created when a cap is hit; the owner decides on the approvals screen; approve raises the allowance, deny marks the agent stopped. World is not a target, so this is plain app auth plus an on-chain allowance change

**A4. HCS audit** (`lib/chain/hcs.ts`) — once Harshal's state machine (B3) emits real `SiegeEvent`s

- One topic per castle. Messages: `vault.state` (each state transition, with reason), `siege.start` (siegeId, payer, receipt), `siege.message` (turn, hash of message, proxy request id, transport), `siege.end` (result, transcript hash), `vault.release` (tx id)
- Mirror-node reader so Lane C's replay can show the chain of hashes next to the Swarm transcript

**A5. Verifier signing** — once Harshal's verifier (B4) returns a verdict for the `wooden` fixture

- Lane B's verifier produces `{ siegeId, transcriptHash, ok: true }`; Lane A signs it with the verifier key and calls `release`. Keep the key out of Next routes: sign in the worker

**A6. Sponsor compliance and pitch** — first pass once the demo path passes (Checkpoint 2); final pass at the freeze (Checkpoint 5)

- Hedera README section: testnet proof, spend limits, audit log, HashScan links for a full siege and a payout
- Pitch deck and the demo script; the recorded video is Lane A's voice

## Lane B: guardian and siege engine (Harshal)

Goal: a guardian that holds, opens only when genuinely convinced, and leaves a verifiable record, whether it runs on our hosted runtime or inside someone else's harness through the SDK. Nothing here touches money; `start` receives a `PaymentReceipt` or `free: true` from Lane A and trusts it. The state machine never knows which transport it is talking to.

**B1. 0G client and tool calling** (`lib/guardian/`) — starts right after Checkpoint 0; the model choice is the first thing settled

- OpenAI-compatible client against the 0G router, but always through `lib/proxy/` with the vault's model key, never with the team key directly; model id from the dashboard; keep temperature low
- Tool definitions: the protected tool (`unlock_vault` for hosted guardians) is the only real tool. Decoys (`check_ledger`, `request_audit`) exist only on Stone and Iron tiers and do nothing
- `GuardianDecision { reply, move: 'hold'|'open', toolCalls, requestId, raw }`: every response parsed into this; a tool call to the protected tool is the only thing that means `open`
- First test: run `wooden.md` against the three-message break fixture and the five must-not-break fixtures on two candidate models; pick the one that follows tools reliably

**B2. Prompt assembly** — once B1 passes the fixtures on the chosen model

- System prompt = tier hardening preset + the Castellan's orders + the tool contract. Orders are fetched decrypted from Postgres only inside this module and never logged
- Siege context = the siege's own messages only; no memory across sieges by construction

**B3. Siege state machine** (`lib/siege/`) — once B1 is reliable; runs against Dhruv's pay stub and Suja16's Arkiv stub until those go real

- States: `created → in_progress → held | broken | banished`; five turns; one `transport.respond()` call per Raider message. The machine imports `GuardianTransport` only; `hosted` is the first implementation, `sdk` arrives in B9 behind the same interface
- Emits `SiegeEvent` for every transition and every message, carrying `transport` and the proxy `requestId`, which Lane C streams and Lane A writes to HCS
- Transcript assembled in order and hashed (`sha256` over a canonical JSON) at `end`

**B4. Verifier** — once B3 produces a stable transcript hash

- Verifies from the **proxy's request record**, not from whatever the transport reported: recomputes the transcript hash from stored messages, confirms the final response was issued on this vault's model key inside this siege, and that the raw response carries a tool call to the vault's `protectedTool`. Returns `{ siegeId, transcriptHash, requestId, ok }` for Lane A to sign. Same code path for hosted and SDK guardians
- Be exact in the README about what is checked; do not call it a proof unless 0G returns an attestation you verify

**B5. Raider agent runner** (`lib/agents/`, `worker/`) — once Dhruv's A2 pays a real siege and A3's `checkCaps` exists

- Takes a strategy text, a target castle and the caps from Lane A; loops: check caps → `start` (pays via Lane A) → up to five messages generated by a 0G call with the strategy as system prompt → read the result → repeat or stop
- On a cap hit, creates an `ApprovalRequest` through Lane A and waits
- Three built-in strategies shipped as files: authority impersonation, incremental commitment, confusion

**B6. Referee and portraits** — only after Checkpoint 2 (the demo path passes)

- Referee: a separate 0G call per siege end scoring each message 0–100 with a one-line tactic label; writes to the siege record; never consulted by the state machine
- Portraits: one image call per guardian with a fixed style template; three candidates, Castellan picks

**B7. Difficulty presets** (`lib/guardian/tiers.ts`) — after Checkpoint 2; tuned once real sieges from other hackers have run

- Wooden: orders only. Stone: hardened preamble, Expose instruction. Iron: decoy tools plus a two-step confirmation rule before `open_vault`
- Each preset ships with a fixture that must hold and, for Wooden, one that must break

**B8. 0G proxy and per-vault model keys** (`lib/proxy/`, `app/api/proxy/`) — starts with B1, because B1 must use it from day one

- OpenAI-compatible endpoint that forwards to the 0G router with the team key and issues a scoped model key per vault; every request is tagged with vault and, when inside a siege, siege id and turn
- Request record: request id, vault, siege, hash of the system prompt, whether the response carried the protected tool call. Content is not stored; only hashes. If 0G exposes request records without content, use those and drop the forwarding path
- Prompt-hash tracking: the hash recorded at `verified` is compared on every request while `guarding`; a change raises `vault.ordersChanged` and Lane A auto-closes

**B9. The `siege-guard` SDK** (`packages/guard-sdk/`) — after Checkpoint 2, once B8 is the only inference path

- `createGuard({ vaultId, guardKey })`: handshake with `api/guard/`, receives `baseURL` and `modelKey`, opens an outbound WebSocket, registers SDK version and host; webhook mode for serverless
- `guard.tool(name)`: wraps any tool; `dryRun` (default) intercepts the call and reports it, `live` lets it execute
- `guard.listen(handler)`: delivers attacker messages, returns the harness's reply through the socket
- Wiring self-check on init: one completion must come back on the vault key with a request id; the tool list must contain the protected tool; a forced dry call must hit the wrapper. Each failure prints the exact fix
- `examples/guard-refund-bot/`: a Vercel AI SDK support bot with `issue_refund` protected, guarded in three lines; this is the one that runs on the board during the event

**B10. Smoke siege, heartbeat, canaries** (`worker/`) — with B9

- Smoke siege: three canned messages through the real loop before a vault can become `verified`; the third must not break the agent
- Heartbeat: socket ping; three misses → `dormant`, in-flight sieges refunded by Lane A, board listing removed; reconnect reruns the smoke siege
- Canaries: a free canned message every N minutes while `guarding`; reply must arrive on the vault key
- Single lease per vault; a second `createGuard` with the same key is rejected

## Lane C: frontend and shared state (Suja16)

Goal: every screen in the product plan, driven by live events, with castles and sieges read from Arkiv and replays read from Swarm. Until Checkpoint 1 this lane runs entirely against fixture events from the stubs.

**C1. Arkiv entities** (`lib/arkiv/`) — starts right after Checkpoint 0; depends on nothing from the other lanes

- Schemas with annotations the board filters on: `castle` (owner = Castellan wallet; `pot`, `fee`, `tier`, `streak`, `status`, `vaultState`, `transport`, `protectedTool`; expires at the vault deadline), `siege` (owner = Raider wallet; `castleId`, `turn`, `status`; expires 10 minutes after end), `guardianProfile` and `raiderProfile` (owner = that agent's wallet; no expiry)
- Writers called by Lane B's state machine and vault state transitions through `lib/arkiv/writers.ts`; queries exposed as `listCastles(filter)`, `liveSieges()`, `profile(wallet)`. Only `guarding` castles are listed on the board
- Board and SDK discovery read from Arkiv directly. Postgres never holds castle or siege state

**C2. Live events** (`app/api/events/`, `worker/`) — once the `SiegeEvent` type is frozen; real events arrive when Harshal's B3 lands

- SSE endpoint fanning out `SiegeEvent` and `BoardEvent`; the worker publishes, the Next route streams
- A client hook `useSiege(siegeId)` and `useBoard()` with reconnect; fixtures replayable with a `?demo=1` flag for UI work without a backend

**C3. Core screens** — built against fixtures first; each goes live when its data source lands

| Screen | Route | Reads from | Goes live when |
| --- | --- | --- | --- |
| Arena Board | `/` | Arkiv `listCastles`, SSE board events | C1 queries return real entities |
| Siege Room | `/siege/[id]` | SSE siege events; posts messages to `/api/siege/message` | Harshal's B3 streams real events |
| Build a Guardian | `/build` | posts to `/api/castle/create`; portrait candidates from Lane B | B2 accepts orders; portraits after B6 |
| Bring your agent | `/bring-your-agent` | vault state over SSE; install snippet with the vault's ids | B9 handshake lands; shows connected → self-check → smoke siege → verified, and an Open button enabled only at `verified` |
| Raider Setup + Approvals | `/raider`, `/raider/approvals` | Dhruv's caps and `ApprovalRequest` list | A3 lands |
| Replay | `/replay/[id]` | Swarm transcript + HCS hashes via Dhruv's mirror reader | C4 and A4 both land |
| SDK docs | `/docs` | static, generated from the SDK README | B9 lands |

The Siege Room ships the guardian move animations (hold shield, open doors) and the "waiting for owner" state. Expose and Banish animations come only after the engine supports those moves.

**C4. Swarm transcripts** (`lib/swarm/`) — once B3 emits `siege.end` with a full transcript

- On `siege.end`, encrypt the transcript JSON, upload to Swarm, store the reference encrypted in the siege entity
- Replay fetches, decrypts, verifies the hash against HCS, and renders turn by turn

**C5. Part 2 screens** — only after Checkpoint 2, in this order, cut from the bottom

- Leaderboards and Hall of Breaks from Arkiv profile queries
- Spectator Wall at `/wall`: rotating full-screen view for the venue display
- Titles and badges, computed client-side from profile fields

**C6. Arkiv deliverables** (`arkiv/*.md`) — once C1 queries are real; finished at the freeze (Checkpoint 5)

- `why-arkiv.md`, `how-you-use-arkiv.md`, `entities.md`, `swarm.md`; each with one runnable query or snippet. They are 25% each of the Arkiv score and most teams write them badly, so give them real time

**C7. Vault states on the board** — once B8/B10 emit `vault.state`

- Badges: `verified` (hosted or SDK), `dormant` greyed out with "last seen", `broken` with the break link; `guarding` is the only state that takes sieges
- Castellan's castle page shows the live heartbeat and the last canary result, so an owner can see their harness is really being hit

## Interfaces between lanes

Everything below lives in `lib/types/` and is frozen at Checkpoint 0. A change after that needs all three to agree and a commit that updates the stubs in the same PR.

| Interface | Producer | Consumer | Shape (summary) |
| --- | --- | --- | --- |
| `pay.gate(req)` | A | B's `start` route | Returns `PaymentReceipt` or throws 402; `free` path returns `{ free: true }` |
| `PaymentReceipt` | A | B, C | `{ siegeId, txId, payer, amount, asset, hashscanUrl }` |
| `pay.checkCaps(agentId, castleId, amount)` | A | B's agent runner | `{ ok } \| { ok: false, approvalRequestId }` |
| `ApprovalRequest` | A | C's approvals screen, B's runner | `{ id, agentId, reason, amount, status: pending\|approved\|denied }` |
| `chain.recordAttempt(siegeId)` | A | B's state machine on `held` | Returns tx id for HCS and the event stream |
| `chain.release(siegeId, verdict)` | A | B's verifier on `broken` | Signs and calls the contract; returns tx id |
| `chain.audit(event)` | A | B's state machine and vault state transitions | Writes to the castle's HCS topic |
| `chain.closeVault(vaultId, reason)` | A | B10 on `ordersChanged`; owner | Auto-close path; refunds in-flight sieges |
| `GuardianTransport` | B | B's state machine only | `{ kind: 'hosted'\|'sdk', respond(castleId, siegeMessages): GuardianDecision, status(): VaultState }` — the machine never imports anything else from `lib/guardian/` |
| `VaultState` | B | A, C | `created\|connected\|verified\|funded\|guarding\|dormant\|broken\|closed`, with `reason` on transitions |
| `proxy.issueKey(vaultId)` / `proxy.record(requestId)` | B | B's transports and verifier; A for HCS | Vault-scoped model key; request record `{ requestId, vaultId, siegeId?, turn?, promptHash, protectedToolCalled }` |
| `siege.start / message / state` | B | C's Siege Room, A's x402 route wraps `start` | `Siege { id, castleId, turn, status, messages[] }` |
| `SiegeEvent` | B | C's SSE, A's HCS writer | `{ siegeId, type, turn?, transport, requestId?, payload, at }` with `type` in `start, message, decision, end, release` |
| `verifier.verify(siegeId)` | B | A's release | `{ siegeId, transcriptHash, requestId, ok }` from the proxy record |
| `guard` SDK handshake | B | external harnesses | `createGuard → { baseURL, modelKey, socket }`; `tool(name)`; `listen(handler)` |
| `arkiv.write*(entity)` | C | B's state machine and vault transitions | Upserts `castle`, `siege`, profiles; returns entity key |
| `arkiv.listCastles / liveSieges / profile` | C | C's screens, B's agent runner (discovery) | Filtered reads straight from Arkiv; board lists `guarding` only |
| `swarm.put(transcript) / get(ref)` | C | B on `end`, C's replay | Encrypted upload; reference stored on the siege entity |

Two conventions that avoid merge pain: every function is `async` and returns a typed result rather than throwing for expected outcomes (402, cap hit, hold), and every event carries `siegeId` so any lane can correlate without joins.

## Merge checkpoints

Six times the three lanes stop and merge to `main`. A checkpoint is gated on dependencies, not the clock: it happens when the listed pieces exist, and each has a test that must pass before anyone goes back to their branch.

1. **Checkpoint 0: foundation.** Gate: repo layout, `.env.example`, `lib/types/` (including `GuardianTransport` and `VaultState`), stubs and fixtures merged. Test: `pnpm dev` boots, the board renders fixture castles, a fixture siege plays in the Siege Room from stub events. Unblocks: A1, B1 with B8, C1 in parallel.
2. **Checkpoint 1: first real siege.** Gate: A1 deployed, A2 paying, B1–B3 replacing their stubs with inference going through the proxy, C2 streaming real events, Arena Board and Siege Room live. Test: pay for a siege on a hosted `wooden` castle, type five messages, guardian holds, Castellan balance updates on HashScan. Unblocks: A3, A4, B4, C4.
3. **Checkpoint 2: first real break (the demo path).** Gate: B4 verifier reading the proxy record, A5 release wired, A4 HCS writing, C4 replay reading Swarm and HCS. Test: the three-message fixture breaks `wooden`, the vault pays out, the replay shows the transcript hash matching HCS. Nothing after this may break it. Unblocks: B5, B6, B7, B9, C5, A6 first pass.
4. **Checkpoint 3: agents and approvals.** Gate: B5 raider runner, A3 caps and approvals, Suja16's approvals screen. Test: a raider agent hits its cap, the owner denies on the phone, the agent stops; approve the next request, it continues. Unblocks: C6, README writing.
5. **Checkpoint 4: first external agent guarding.** Gate: B9 SDK with handshake and self-check, B10 smoke siege and heartbeat, C7 vault states and the Bring-your-agent screen, `examples/guard-refund-bot` running. Test: the refund bot is guarded in three lines, passes the smoke siege, shows `guarding` on the board, a Raider sieges it and is refused, the bot's process is killed and the castle goes `dormant` with the siege refunded, it restarts and returns to `guarding`. Unblocks: SDK docs, the business slide.
6. **Checkpoint 5: freeze.** Gate: C5 Part 2 screens, B7 presets, C6 Arkiv markdown, all READMEs. Test: full demo rehearsed twice on the spectator wall with the recorded video's script. After this, only demo-path bug fixes merge.

Between checkpoints, each lane merges `main` into its branch each time a checkpoint lands. A lane that is blocked on another lane's interface keeps working against the stub and files the gap as a one-line issue; it never patches the other lane's code.

## The demo path and how it is tested

One scripted path, run from Checkpoint 2 onward, and the only thing that is never allowed to regress.

**The path**

1. Board shows five seeded castles (seed script: `pnpm seed`, owned by A, run by anyone)
2. Open the `wooden` castle, pay via x402, type three fixture messages, guardian holds twice then opens
3. Vault pays out; HashScan link appears; replay opens with the transcript hash matching HCS
4. Open a `stone` castle with a raider agent on the built-in authority strategy; it fails, hits its cap, requests approval
5. Owner denies on the phone; agent stops. Owner approves a second request; agent resumes
6. Bring your agent: start `examples/guard-refund-bot`, watch it go connected → verified → guarding on the board, siege it from the Siege Room and get refused by a real support bot with `issue_refund` under guard

**How it is tested**

- `pnpm demo` runs steps 1–5 headless against testnet and asserts on each event; it is the Checkpoint 2 test and runs before every merge after it
- A `?demo=1` mode on the Siege Room replays the recorded event stream for UI polish without touching testnet
- One "golden" siege id and one golden break id are kept in `.env` so the replay and HashScan links in the README always point at something real
- The free daily siege is tested separately: it must never reach `release`

**Recording**

- Laptop screen capture at normal speed, Lane A's voice, under three minutes, following the pitch outline in the product plan. Recorded at Checkpoint 5 after the second rehearsal, not at 5 a.m. on Sunday

## Risks per lane

| Lane | Risk | Fallback | Decide when |
| --- | --- | --- | --- |
| A | x402 facilitator on Hedera testnet is flaky or undocumented | Self-host the reference facilitator; if that also fails, a direct HBAR transfer checked by the server before `start`, with x402 restored as a stretch | Before A2 starts, at the Hedera booth |
| A | Contract deploy or HTS USDC association eats the morning | Use HBAR for the whole weekend; USDC is a README note | If A1 is not deployed by the time B1 passes its fixtures |
| B | The chosen 0G model ignores tool definitions or hallucinates the protected tool | Test two models first; if both fail, detect `open` from a strict JSON schema in the reply instead of a tool call, and say so in the README | Before B2 starts |
| B | `wooden` never breaks or `stone` breaks instantly | Tune presets against fixtures at Checkpoint 1; the demo break is scripted on a fixture, never improvised | At Checkpoint 1 |
| B | 0G latency makes a five-message siege feel slow | Stream the reply tokens to the Siege Room; show the "thinking" state with the request counter | When the Siege Room goes live |
| B | Proxy adds latency or breaks streaming for external harnesses | Pass-through streaming from day one; if 0G exposes request records without content, verify from those and drop forwarding | When B8 starts |
| B | External harness uses a model 0G doesn't host | Document the supported model list in the SDK README; the refund-bot example uses a hosted one | Before B9 |
| B | Socket from a harness behind a corporate proxy fails | Webhook mode with signed pings; documented as the serverless path | When B9 starts |
| C | Arkiv writes lag or the RPC drops under load | Write-through cache in memory for the board with Arkiv as the source on refresh; keep the queries real so the "why Arkiv" story holds | When the board goes live on real entities |
| C | Swarm gateway unavailable | Store transcripts in Postgres with the same hash on HCS; keep the Swarm reference field and note the bonus as not claimed | When C4 starts |
| All | Interface change after Checkpoint 0 | Only by a PR that updates `lib/types/` and every stub together, reviewed by all three | Always |
| All | Someone starts Part 2 or the SDK before Checkpoint 2 passes | Checkpoint 2 is the gate; nothing from C5, B6, B7 or B9 merges before it | At Checkpoint 2 |
| All | State machine calls the 0G client directly, or hosted guardians bypass the proxy | Lint rule: `lib/siege/` may import only `lib/transport/`; `lib/guardian/` may only use `lib/proxy/` keys. Enforced from Checkpoint 0 | Checkpoint 0 |

## Sponsor deliverables checklist

Owned per item; Lane A reviews the whole list at Checkpoint 5.

**ETHGlobal**

- [ ] Public repo, MIT licence, AI-usage note (A)
- [ ] Demo video under three minutes, screen capture, normal speed, own voice (A)
- [ ] Three partner programs selected: Hedera x402, 0G Private Computer, Arkiv Build (A)

**Hedera x402**

- [ ] README section: how an agent pays with no human, spend caps, approval above cap, HCS audit log (A)
- [ ] HashScan links: contract, a full siege's receipts, one payout, one HCS topic (A)
- [ ] Testnet proof in the video (A)

**0G Private Computer**

- [ ] Request IDs visible in the Siege Room and in the replay (B, C)
- [ ] README: which models, the exact checks the verifier makes, and the one-sentence "what breaks without 0G" (B)
- [ ] Privacy note: orders and strategies are never logged or readable by the operator (B)

* [ ] Bring-your-agent: SDK README with the three-line integration, supported models, `dryRun` default, and what the self-check verifies (B)
* [ ] The refund-bot example guarded and sieged on video (B, C)

**Arkiv (+ Swarm)**

- [ ] `arkiv/why-arkiv.md`, `how-you-use-arkiv.md`, `entities.md`, `swarm.md` with one runnable query each (C)
- [ ] Board and discovery provably read from Arkiv, not a cache: a screen recording of a query (C)
- [ ] Swarm reference on a siege entity and a replay that opens from it (C)

**Pitch**

- [ ] Deck following the product plan's outline (A)
- [ ] Spectator wall running on the table from Saturday morning with the seeded castles (C)
- [ ] Season numbers captured at the freeze: castles, sieges, breaks, longest streak (C)

* [ ] Business slide: "three lines and your agent is in the arena", with the refund bot as the live proof (A)
