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

## 3. Discovery through Arkiv, done by the owner, not the agent (Sujal)

Product decision (Sujal, 6 Nov): the raider agent's owner picks the target castle; the agent does not choose on its own. So no change to `worker/agents.ts` or `startRun`.

What makes "why Arkiv" real under that decision:
- The raider setup page (`/raider`), where the owner picks a castle, already loads its list through `api.castles()`, which reads Arkiv in live mode. Add the same tier, sort and minimum-pot filters as the board, so the owner's choice is an Arkiv query they apply.
- An "under siege" marker on each castle from `arkiv.liveSieges()`, so the owner avoids a castle already being attacked. This is the "claims that agents share and let expire" part of the Agents direction: a siege claim shows while it is live and drops off ten minutes after it ends, with no cleanup code.
- The README's runnable query is the same castle query the raider page runs.

Honest answer to "swap Arkiv for Postgres": a raider, or anyone building their own raider, could only discover castles and live sieges through our API. With Arkiv they query the chain directly, and stale claims expire instead of needing a cleanup job.

No decision needed from Lane A/B.

## 4. Ownership: each Castellan owns their castle record (decided, Sujal 6 Nov)

This is the center of the "why Arkiv" answer: a Castellan owns their listing the way no Postgres row can be owned.

On Arkiv only the owner may edit an entity, so a castle becomes two entities:

- **`castle`** (identity): name, guardian name, tier, transport, protected tool, deadline, portrait. The arena creates it, then `changeOwnership` to the Castellan's wallet. Created `readonly`: nobody, including the arena, can change it afterwards. The Castellan can delete it from their own wallet, which is how they delist. Expires at the vault deadline.
- **`castleState`** (mutable): pot, fee, streak, siege count, status, vault state, last seen. Owned by the arena, because these values change only through settlement the arena performs on Hedera. Expires at the vault deadline. Carries `castleId`, `name` and `tier` too, so the board filters on one entity (no joins on Arkiv).

Visible to users: "owned by 0x…" on every card with an explorer link; a Castellan deleting their `castle` entity removes their listing; the live numbers still come from `castleState`.

**Needs from Lane A (notice, not a question):** a Castellan wallet address column on `castles` (an EVM address, since Arkiv cannot use a Hedera `0.0.x` id as owner), set when a castle is created. The Build a Guardian form (Lane C) collects it. Seeded castles get generated addresses. Sieges and profiles stay arena-owned.

## 5. Keep off Arkiv, stated in the docs (no decision)

Guardian orders, payment receipts, approval requests, owner secrets, proxy records, raw transcripts (Swarm; only the reference lives on the siege entity). Already true in code (`lib/arkiv/schema.ts`), just needs writing down.

## 6. Reach and friction (Sujal, with one ask)

- `reach.md` needs a public URL judges can open, honest counts at the freeze, and the SDK docs page pointing third-party agent authors at the discovery query.
- `friction.md` is written from real pain so far: an expiry cannot be shortened, 2-second blocks and nonce collisions forcing an outbox, the typed query builder fighting dynamic filters, no joins. Each with repro steps.
- **Ask:** the deploy URL as soon as it exists.

## Order of work for Lane C once confirmed

1. Qualification pack (section 1).
2. Board UI (section 2).
3. Raider page filters and the under-siege marker (section 3).
4. C2 live-update hooks, then the rest of the C3 screens.
