# Arkiv track: what still needs to change

Sujal · Fri 6 Nov 2026 · for Dhruv and Harshal to confirm before Lane C continues

The "Build on Arkiv (from scratch)" track scores four files at 25% each and has hard qualification rules. I read the brief against the code on `main` (after the C1 merge) and had the reading reviewed independently. This is the gap list, with who owns each item and the decisions I need from you.

## How the judges read it

Arkiv has three primitives: **indexed filters**, an **owner wallet** per entity, and an **expiry** per entity. Every criterion tests whether those three do visible work in the product. The sentence that decides most of the score: *"Does each Arkiv feature you use change something your users see?"*

- A filter counts only if a user applies it.
- Expiry counts only if something visibly disappears at a meaningful moment.
- Ownership counts only if we can say who may edit each entity and why that fits the app.
- "Why Arkiv" is scored on *"if you swapped Arkiv for Postgres, what would your users lose?"* A mirror of our own database scores badly here.
- Siege fits the brief's first suggested direction word for word: *"Agents: ephemeral coordination state: tasks, bids and claims that agents share, query and let expire."* Castles are open bounties, a siege is a raider agent's claim, both expire.

## 1. Qualification failures (zero score until fixed)

| Item | Status on main | Owner | Ask |
|---|---|---|---|
| Open-source `LICENSE` at the repo root | Missing | Dhruv (on his checklist) | Add MIT, or tell me to |
| `arkiv/schema.md`, `friction.md`, `reach.md`, `why-arkiv.md`, `how-you-use-arkiv.md` | No `arkiv/` directory. The tech plan lists `entities.md`, which the track does not score | Sujal | Will write; plan file list to be corrected |
| README: writer wallet address + one query judges can run + AI-usage note | None of the three | Sujal (wallet, query), Dhruv (AI note sits with the ETHGlobal items) | Agree where the AI note lives |
| Deployed app runs `ARKIV_MODE=live` with `ARKIV_PRIVATE_KEY` and `ARKIV_ACCESS_KEY`, and `npm run arkiv` running next to the worker | Local only | Dhruv (deploy) + Sujal (env) | Which host, and can it run a third process? If not, I fold the drainer into the worker loop |

Writer wallet: `0xA69d59B6d6e55Aa6da960405D4150ea59460bb18` (Rabdi testnet, chain id 7794095).

## 2. Board UI, so the primitives are visible (Sujal)

Today `GET /api/castles` can read Arkiv, but the board sends no filter, ignores the `arkiv` meta the route returns, and splits guarding/resting client-side. So none of the three primitives changes anything a user sees yet.

- Tier, sort and minimum-pot controls wired to the route's existing `tier`, `sort`, `minPot` params, so the indexed columns are filters users apply.
- Owner badge on every card ("published by arena 0xA69d…") linking to the explorer entity.
- "Expires in" on every card from the entity's `$expiresAt`; a castle leaving the board at its vault deadline is the visible expiry.
- Source label and Arkiv block number under the grid, and a visible "Arkiv unreachable, showing cached copy" banner when the route falls back to SQLite. Never a silent fallback on the demo.
- For SDK guardians (`transport = sdk`): expiry = `lastSeen` + N minutes, so a dead guardian vanishes from the board on its own. This needs the heartbeat from B10 to update `lastSeenAt`; I write the entity extension.

No decision needed; listing so you know what the board will look like.

## 3. Agent auto-targeting through Arkiv (needs Lane A/B agreement)

This is the item that makes "why Arkiv" a real answer.

Today a raider agent never discovers anything: the owner picks the castle on `/raider` and `startRun(agentId, castleId)` fixes it (`app/api/_lib/runs.ts`). Nothing in product code calls `arkiv.liveSieges()`.

Proposed, small:
- Allow a run with no `castleId`. In the run loop (`worker/agents.ts`), call `arkiv.listCastles({ tier, sort: "fee" })` through the port, log the query it ran as an agent event, and take the top `guarding` castle within the agent's caps.
- Before paying, call `arkiv.liveSieges()` and skip a castle that already has a live siege ("avoid", not "lock": the start route stays as it is).
- The README's runnable query is exactly this discovery query, so judges run what our agents run.

Then the honest answer to "swap Arkiv for Postgres" is: any raider agent, ours or a stranger's, loses the ability to find castles without our API, and stale claims would need a cleanup job instead of expiring.

**Decision needed:** may Lane C make this change in `worker/agents.ts` and `app/api/_lib/runs.ts`, or does one of you do it against `ArkivPort`? Estimate 2 to 3 hours either way.

## 4. Ownership: arena keeps it (decision to confirm)

All entities are owned by the arena wallet, and every read filters `.ownedBy(arena)`. I propose we keep that and say why in `how-you-use-arkiv.md`: pots and streaks are settled on Hedera by the arena, so only the arena may write them, and the owner filter is what stops a stranger from planting a castle on the board under our schema name.

The alternative, per-Castellan ownership via `changeOwnership`, needs an EVM address per Castellan (we only have Hedera ids), wallet connect for delisting, and breaks the outbox's patch model. Half a day for one line of markdown.

**Decision needed:** agree arena ownership, or ask for the split.

## 5. Keep off Arkiv, stated in the docs (no decision)

Guardian orders, payment receipts, approval requests, owner secrets, proxy records, raw transcripts (Swarm; only the reference lives on the siege entity). Already true in code (`lib/arkiv/schema.ts`), just needs writing down.

## 6. Reach and friction (Sujal, with one ask)

- `reach.md` needs a public URL judges can open, honest counts at the freeze, and the SDK docs page pointing third-party agent authors at the discovery query.
- `friction.md` is written from real pain so far: an expiry cannot be shortened, 2-second blocks and nonce collisions forcing an outbox, the typed query builder fighting dynamic filters, no joins. Each with repro steps.
- **Ask:** the deploy URL as soon as it exists.

## Order of work for Lane C once confirmed

1. Qualification pack (section 1).
2. Board UI (section 2).
3. Agent auto-targeting (section 3), if approved for Lane C.
4. C2 live-update hooks, then the rest of the C3 screens.
