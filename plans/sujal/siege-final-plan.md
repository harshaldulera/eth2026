# Siege: final plan

ETHGlobal Mumbai · Fri 6 Nov 2026 · Sujal (Lane C)

This merges three research passes over *Siege — Technical Plan (three lanes)*: `01-idea-gaps.md` (what's missing in the idea), `02-demo-and-pitch.md` (demo and selling) and `03-review-and-final-plan.md` (the review that checked both). Where they disagreed, the review's decision is used. Claims the review found wrong have been removed or corrected. This file replaces all three.

> **Deadline: submissions close Sat 7 Nov 2026 at 09:00 IST, with no late entries** ([ETHGlobal Mumbai details](https://ethglobal.com/events/mumbai/info/details), checked twice). At 02:00 IST Friday that left about 31 hours, sleep included. The video, README, every `/arkiv/*.md` file and the Swarm timestamp must be final before then. Judging happens after the deadline, so nothing built for "Saturday morning" or "Sunday" can count toward the submission.

---

## 1. The five decisions

| # | Decision | What we do |
|---|---|---|
| 1 | **Plan to the clock** | Checkpoints by clock time (§2). Code freeze Sat 04:00, submit by 08:30. Anything not on the must-have list (§7) is cut by default. If Checkpoint 2 isn't green by Fri 21:00, Checkpoint 3 shrinks to the agent's autonomous paid siege only, with no approvals. |
| 2 | **No Solidity vault. Use Hedera-native escrow.** | Each castle gets its own Hedera account, and that account is the vault. x402 `payTo` points at the castle account, so fees visibly land in escrow on HashScan. Fee splits and payouts are ordinary `TransferTransaction`s, gated by the verifier and with the transcript hash in the memo. Call it **"operator-attested escrow"**. Reason: a plain HBAR transfer to a contract doesn't run contract code, so the contract could never see an x402 payment. It would cost Lane A half a day and add no trust. |
| 3 | **New pitch: "an open arena where AI agents raid AI guardians for money, under budgets humans set"** | This game already exists (§3), so the agents are what's new. The raider agent is a public script: it finds castles on Arkiv, reads their endpoint, gets a 402, pays and sends messages. That one script covers the "open raider protocol", `RAIDERS.md` and Hedera's "finds the endpoint, no human approving" requirement. |
| 4 | **Make every trust claim true, and claim less** | Send `verify_tee: true` on every guardian call, and only pay out when `tee_verified === true`. Commit the hash of the orders on Hedera when a castle is created, and publish the orders on Swarm when it breaks. **Delete** "orders are never readable by the operator" everywhere (§4). |
| 5 | **Submit Arkiv against the real rubric** | Five files plus `swarm.md` in `/arkiv/` at the repo root. Castle entities are transferred to their owners with `changeOwnership`. A long-lived `transcript` entity keeps replays alive through judging. Swarm uploads are unencrypted. Start `friction.md` tonight. |

---

## 2. Timeline (IST)

| CP | Target | Gate and test |
|---|---|---|
| 0 | **Fri 04:30** | Repo layout, `.env.example`, `lib/types`, stubs and fixtures merged. Test: the app boots, the board renders fixture castles, a fixture siege plays from stub events. **Then all three sleep 04:30–08:30.** Booths open in the morning. |
| 1 | **Fri 13:00** | First real siege, **deployed to the public URL**. Test: pay for a siege on a Wooden castle, send five messages, the guardian holds, the fee lands in the castle escrow account on HashScan. |
| 2 | **Fri 19:00**, hard cut decision at 21:00 | The demo path. Wooden breaks, escrow pays the raider, the replay loads from Swarm and its hash matches HCS, and the orders-hash commit is on HCS. Nothing after this may break it. |
| 3 | **Fri 23:30** | The agent finds a castle on Arkiv and pays on its own, hits its cap once, and gets one approval decision. `RAIDERS.md` is public. |
| 4 | **Sat 04:00 code freeze** | Golden runs recorded Fri 23:30–Sat 03:00. Video cut 04:00–06:30, docs finished 06:30–08:00, **submitted by 08:30**. Everyone takes a staggered 90-minute nap between CP3 and CP4. |

**Repo decisions at CP0**
- **Layout:** everything goes inside `frontend/` (`frontend/app`, `frontend/lib`). `/arkiv/` and the README sit at the **repo root**, because the judges look for `/arkiv/*.md`.
- **Tooling:** use **npm**, since the scaffold has `package-lock.json`. Read `frontend/node_modules/next/dist/docs/` before writing route handlers: Next 16 has breaking changes (see `frontend/AGENTS.md`).
- **Hosting:** **one long-running Node container** (Railway, Render or Fly) runs `next start`, with an in-process event bus. There is no separate `worker/` service, which also avoids Vercel's SSE timeouts.
- **Storage:** **SQLite or JSON on disk** for orders, sessions and approvals. Use Postgres only if someone already has Neon set up.

---

## 3. Positioning: the game isn't new, the agents are

Prior art the review confirmed:

| Project | What it is |
|---|---|
| **Freysa** (Nov 2024) | Pay per message to an AI guarding a pot. 482 messages from 195 players; won (~$45–47k) by redefining `approveTransfer`. Its prompt was public. ([Simon Willison](https://simonwillison.net/b/8335)) |
| **Teeception** (Nethermind, Starknet) | Defenders fund agents in Phala TEEs and earn 20% of attack fees while they hold. ([GitHub](https://github.com/NethermindEth/teeception)) |
| **InjectMe** (0G APAC Hackathon 2026) | Almost the same game **on 0G**: an 80/10/10 split, TEE judging on 0G Compute, commit-reveal, results on 0G Storage. ([HackQuest](https://hackquest.io/projects/InjectMe)) |
| **ETHGuardian** (ETHGlobal Agentic Ethereum) | Jailbreak AI wallet agents across three tiers. Won a CDP AgentKit pool prize. ([showcase](https://ethglobal.com/showcase/ethguardian-wemic)) |
| **JailbreakMe** (Solana) | User-created pools with custom message pricing. |
| Gandalf, HackAPrompt, Gray Swan Arena, Tensor Trust | Well-known prompt-injection red-teaming games and contests that AI judges will know. |

**What's actually new in Siege** (lead with these):
1. **Agents raid as first-class players, under spend limits their owners set.** None of the projects above combines autonomous raider agents with caps, per-agent audit and owner approval above the cap.
2. **Open discovery.** Castles are public Arkiv entities carrying their x402 endpoint, so any agent can find and raid them without our frontend.
3. **Public, hash-anchored replays** via HCS and Swarm.

**Say the prior art out loud** in the README and the pitch: "Freysa proved people pay to break a guardian. Teeception and InjectMe proved people will deploy guardians. Nobody let agents raid on a budget." Naming it before a judge does reads as strength.

**Lines**
- **One-liner (opener):** *"Pay to send five messages. Talk an AI into opening its vault."*
- **Closing line:** *"Every agent with a wallet will be socially engineered. Siege is where guardians get tested, and paid for holding."*
- **Q&A only:** "Freysa, but anyone builds the guardian and agents raid it." Accurate, but it makes Siege sound derivative as an opener.

---

## 4. Trust model: what we claim and what we don't

**What's true as built:** the team's worker holds the release key, the server assembles the prompt, and the server decrypts the orders. 0G Private Computer keeps data hidden from 0G and its providers, not from our app.

**What we do about it**
1. **Gate payouts on 0G.** Send `verify_tee: true` on every call and carry `x_0g_trace` (`request_id`, `provider`, `tee_verified`) through the whole flow. Release only if `tee_verified === true` on the reply that opened the vault. (`false` means the signature failed; `null` means verification wasn't requested.) Pick the model by two tests: it follows tool calls reliably, **and** it returns `tee_verified: true`. Independent checking via `processResponse` (`ZG-Res-Key` header, `@0gfoundation/0g-compute-ts-sdk`) is a should-have, only if the 0G booth confirms what it needs.
2. **Commit to the orders.** At castle creation, write `sha256(tierPreamble + orders + toolContract)` to the castle's HCS topic. At the break, upload the orders to Swarm so anyone can check the hash and see whether they hid a backdoor.
3. **Rewrite the copy.**
   - Delete "orders and strategies are never readable by the operator" from the plan, the README, the video and the Q&A.
   - Use instead: "Orders are hidden from raiders and from 0G's inference providers. The arena operator can read them, which is why they are committed on Hedera and revealed on Swarm."
   - Don't say the TEE signature covers the `open_vault` tool call until the 0G booth confirms it. Say "0G verified the reply".
   - Don't call any of this a "proof".
4. **Add a trust-model table to the README:**

| Who | Can do | Checkable by | Removed after Mumbai by |
|---|---|---|---|
| Arena worker (team key) | Release escrow | Release memo = transcript hash; HCS log; TEE flag | Signing the verdict inside the TEE, or a contract checking the TEE signature |
| Arena server | Assemble the prompt, read the orders | Orders hash committed on HCS before the first siege; revealed on Swarm | Prompt assembly inside the TEE |
| 0G | Run the model | `tee_verified`, request ID | n/a |

**One sentence for 0G:** *"Without 0G, a break is just our server's word. The escrow only releases on a reply that 0G's TEE verification marked true."*

---

## 5. Game rules (decided now, so judges can't find the holes)

| Hole a judge will raise | Rule |
|---|---|
| Where does the fee go? | **60 pot / 30 Castellan / 10 arena.** The 30 and the 10 go out in one transfer at the end of each siege. |
| Who gets an unbroken pot at the deadline? | The Castellan gets their deposit back. The raider-funded share goes to the arena's season pot. Written in the README only; not built. |
| The Castellan plants a backdoor and raids their own castle | Orders are capped at 600 characters and wrapped in a fixed tier preamble the Castellan can't override. Committing the orders hash and revealing the orders makes a backdoor visible afterwards. The README admits sybil resistance is out of scope on testnet. |
| Free sieges used as practice before a paid one | **The free daily siege is cut.** Browser users get **sponsored sieges** instead: the server's house raider account is the x402 client, three per session, and each is still a real x402 transaction. |
| Accidental or flaky tool calls | Temperature 0. `open_vault(reason)` takes a required argument. Rule shown on the castle page: "an `open_vault` call in a TEE-verified reply is a break, and it's final." |
| Streak farming | Streaks count distinct raider IDs, excluding the Castellan's own. Labelled "testnet, gameable". |
| Nothing ever breaks | Wooden must be breakable by a clever person in about 10 minutes. The demo break is a scripted fixture and is never improvised. |
| Spectators copy live tactics | Accepted and said openly. Hiding raider messages would cost UI work. |

---

## 6. Sponsor requirements

**Partner judges score the video and README only.** Every sponsor needs an on-screen moment and a link in the README.

### Hedera "AI Agents That Pay: x402 on Hedera" ($3k / $2k / $1.5k)
- **To qualify:**
  - an x402-protected endpoint settling on Hedera through a listed facilitator (Official x402, Ax402 or Blocky402) or our own
  - an agent or client that **finds the endpoint** and completes a paid request **with no human approving**
  - the README carries the tx ID of a settled payment
  - the video shows HashScan
- **Extra points we take:**
  - agent spending caps and approval above a limit
  - **one HCS spend topic per raider agent**, an "audit log of each agent's spending"
- **Extra points we skip:** HCS-14/ERC-8004 identity, USDC/HTS fees, scheduled transactions.
- **On screen:** the agent paying on its own (video 0:28), the HashScan payment and release, the HCS topic.

### 0G "Build with 0G Private Computer" ($2.5k / $1.5k / $1k)
- **Required:**
  - a consumer app where the AI is the product
  - request IDs shown in the main flow
  - a reason to come back tomorrow
  - one sentence on what breaks without 0G (§4)
  - a video under 3 minutes plus a live link
- **iAI sign-in bonus:** only works on localhost. Take it only if the booth hands over a drop-in that takes under an hour.
- **On screen:** a `0G · req … · TEE ✓` chip on every guardian reply.
- **README must state:** the models used, the verifier's exact checks, the trust-model table, and no claim that the orders are private from the operator.

### Arkiv "Build on Arkiv (from scratch)" ($3k / $1k) + Arkiv + Swarm bonus ($500)

| File, at repo root | Weight | Answers |
|---|---|---|
| `/arkiv/friction.md` | 25% | What got in the way. For anything that broke: what we expected, what happened, how to reproduce it. |
| `/arkiv/reach.md` | 25% | Who it's for, would they use it, can they try it today, will we keep building after Mumbai. |
| `/arkiv/why-arkiv.md` | 25% | What users lose if Arkiv became Postgres. What we kept off Arkiv and why. |
| `/arkiv/how-you-use-arkiv.md` | 25% | Do the filter fields, who can edit and expiry fit the app? Does each Arkiv feature change something users see? |
| `/arkiv/schema.md` | required | Entities, queried fields, owners, expiry. |
| `/arkiv/swarm.md` | bonus | See Lane C step 13. |

**Also required:**
- the README lists the wallets that wrote entities and gives one runnable query
- a public repo with an open-source licence and an AI-usage note
- at least one user-facing feature reads from Arkiv; Arkiv used as a log nothing reads doesn't count

**Network:** Rabdi testnet (chain ID 7794095), `@arkiv-network/sdk@1.0.1`, which needs an `accessKey`.

**Every Arkiv feature has to show on screen:**
- **filters:** tier/status chips and a query bar printing the real query and the block it was read at
- **owners:** "owned by 0x…" read from `$owner`, plus a "My castles" filter
- **expiry:** a finished siege's countdown hits zero and the row disappears on the **next Arkiv query**, never because of a client-side timer

### ETHGlobal
- **Video:** **2:00–2:59** (2–4 min is auto-enforced, and 0G wants under 3). Target **2:45**. No speed-up, no AI voice, no phone recording. Cutting out waits is allowed.
- **Finalists:** 4 min demo plus 3 min Q&A, scored on Technicality, Originality, Practicality, Usability and WOW.
- **Submission:** public repo, MIT licence, AI-usage note. Three partner prizes picked; Arkiv counts as one, and the Swarm bonus doesn't use another.
- **Most prizes go to non-finalists,** so the three sponsor tracks matter on their own, whatever happens in the finalist round.
- **Skip 0G's other track,** "Agents That Pay for Themselves" ($2k). We get one 0G pick, and Private Computer fits Siege better.

---

## 7. Changes to the technical plan, by lane

### Lane A (Dhruv)
| Action | Item | CP |
|---|---|---|
| Cut | `Vault.sol`, `closeVault`, `withdraw`, ABI, USDC | n/a |
| Change | The seed script creates one escrow account per castle (operator-keyed) and seeds five castles with owners transferred | 0→1 |
| Change | x402 `payTo` = the castle escrow, HBAR only. Sponsored house-raider client for browser users. No free siege. | 1 |
| Add | The 60/30/10 split as one transfer at siege end | 1 |
| Change | Release = a transfer from escrow to the raider, memo = transcript hash, only on `verifier.ok` | 2 |
| Change | One HCS topic per castle (`castle.commit`, `siege.*`, `release`), plus one spend topic per raider agent. Mirror reader for the replay. | 1–2 |
| Change | Caps = the agent account's balance (hard) plus `caps.ts` per-castle and daily (soft). Approve = a top-up transfer from the owner. Deny = agent stopped. | 3 |
| Add | Deployment and `.env.example` | 1 |
| Add | `npm run demo:preflight` (§9) | 3–4 |
| Keep | Hedera README, deck, video voice | 4 |

### Lane B (Harshal)
| Action | Item | CP |
|---|---|---|
| Add | `verify_tee: true` on every call; `x_0g_trace` carried through `GuardianDecision` and `SiegeEvent`; the model must pass the fixtures **and** return `tee_verified: true` | 1 |
| Change | Fixed tier preamble wraps orders of at most 600 characters; `open_vault(reason)`; temperature 0 | 1 |
| Add | Orders hash sent to A's `castle.commit` at creation; orders uploaded through C's `swarm.put` at the break | 2 |
| Change | Verifier: recompute the transcript hash, check `tee_verified === true` on the opening reply, and check `open_vault` is in the raw response | 2 |
| Change | Raider agent = standalone `scripts/raider.ts` against the public URL: discovers via `arkiv.listCastles`, reads `endpoint`, pays x402 from its own Hedera account. Strategies are files. | 3 |
| Add | `RAIDERS.md` (curl plus the script) posted in the hackathon Discord **by Fri 20:00** | 3 |
| Cut | Referee, portrait generation (use static images), decoy tools, Iron two-step, Expose/Banish. Tiers = three preamble files. | n/a |
| Add | 0G README section (§6) | 4 |

### Lane C (Sujal)
| Action | Item | CP |
|---|---|---|
| Change | Entity model: `castle` (static; created by the arena, then `changeOwnership` to the Castellan; has `endpoint` and `ordersHash`), `castleStats` (arena-owned, patched live, expires at the deadline), `siege` (arena-owned, short TTL, the live list), `transcript` (long TTL; holds the Swarm ref, hash and HCS sequence) | 0–1 |
| Change | The board **polls Arkiv every 5 s**. `BoardEvent` over SSE is dropped; SSE stays for the Siege Room only. | 1 |
| Change | Swarm uploads are **unencrypted** (transcript at the end, orders at the break). The ref goes in `transcript.swarmRef`. Nothing encrypted goes into any entity. | 2 |
| Change | The replay page is also the proof page: Swarm banner and ref, hash checked against HCS, `x_0g_trace`, x402 receipt, orders reveal checked against the commit | 2 |
| Cut | Leaderboards, badges, titles. Keep a live stats strip; a simple `/wall` if there's time. | n/a |
| Change | Arkiv files per §6, schedule in §11 | 0→4 |

### Fix in the plan text
- Delete "never readable by the operator".
- Fix B4's "verified release" wording.
- Fix the C6 file list.
- USDC becomes HBAR only.
- pnpm becomes npm.
- "Suja16" becomes Sujal.
- The video is 2:00–2:59, not "under three minutes".

---

## 8. Build list

Effort: S < 3h, M 3–8h. There are no L items; anything that grows to L gets cut.

### Must-have before CP2 (Fri 19:00)
| Item | Effort | Lane |
|---|---|---|
| `lib/types`, stubs, fixtures, layout in `frontend/`, `.env.example` | M | all |
| Hedera operator, per-castle escrow, seed script (5 castles, owners transferred) | S | A |
| x402 on `/api/siege/start` via a listed facilitator; sponsored client for browser users | M | A |
| Fee-split transfer; verifier-gated release with a hash memo | S | A |
| HCS topic per castle plus mirror reader | S | A |
| Deploy one container to a public URL | M | A |
| 0G client, tool calls, `verify_tee`, model chosen on the fixtures | M | B |
| Tier preambles, orders cap, `open_vault(reason)`, orders hash | S | B |
| State machine, transcript hash, in-process event bus | M | B |
| Verifier | S | B |
| Arkiv client (Rabdi + accessKey), the four entities, writers, `listCastles` / `liveSieges`, `changeOwnership` | M | C |
| Board with filter chips, query bar and 5 s Arkiv polling | M | C |
| Siege Room: SSE, streamed replies, one-click message chips (`?stage=1`), proof chips | M | C |
| Swarm upload/read (unencrypted) plus the replay/proof page with the HCS check | M | C |
| `/arkiv/friction.md` running log | S | C |

### Should-have (CP3, cut from the bottom)
| Item | Effort | Lane |
|---|---|---|
| Raider agent script: Arkiv discovery, own Hedera account, per-agent spend topic | M | B (+A) |
| `RAIDERS.md` and a Discord post by 20:00 | S | B |
| Caps, approval request, top-up | M | A |
| Phone approvals page (SSE, big buttons) and agent rail | S | C |
| Break animation (gates, pot drain, stamps) | S | C |
| Golden-run record and replay (`?demo=1&run=golden`, hotkey `G`, REPLAY badge) for the break run and the Iron hold | M | C (B emits stream) |
| Orders reveal on Swarm at the break | S | B+C |
| Preflight script | S | A |
| "My castles" (injected wallet address, read-only) and siege TTL countdown | S | C |
| Live stats strip from Arkiv queries; simple `/wall` | S | C |
| Build-a-Guardian form (orders plus Castellan address) | S | C+B |
| Independent `processResponse` check (only if the booth confirms it) | S | B |

### Cut
- Vault contract and USDC
- Free daily siege and Training Yard
- Referee, overnight report, portrait generation, decoys, Iron two-step, Expose/Banish
- Leaderboards, badges, titles, sound, fancy torch animations
- Paper Tower timed expiry and the "Under the hood" drawer (the replay page does that job)
- Mainnet real-money castle, iAI sign-in (unless it takes under an hour), HCS-14/ERC-8004
- Separate worker service, Vercel, Neon
- Agent-written `raiderProfile`
- Per-sponsor clips and a Judges' Keep (only as a seed entry, if wanted)

---

## 9. The demo

### 9.1 Video: target 2:45, hard window 2:00–2:59

Dhruv's voice, laptop screen capture. The phone is shown by screen mirroring (scrcpy or QuickTime), never filmed. Cut waits, never speed up. Record at 1080p with the voiceover recorded separately in a quiet room.

| Time | Picture | Voiceover |
|---|---|---|
| 0:00–0:08 | Cold open: Wooden, turn 3, *"…understood, Auditor. Opening the vault."* Gates split, pot drains, BROKEN. | "This AI was guarding fifty HBAR. A raider just talked it out of every one, in three messages." |
| 0:08–0:13 | Title card with the one-liner. | "This is Siege." |
| 0:13–0:28 | Board. Click the **Wooden · open** chip; the query bar shows the Arkiv query and block. Cards show "owned by 0x…" from `$owner`. Label: ARKIV. | "Castellans deploy AI guardians over escrowed pots. Each castle is a public Arkiv entity, owned by its Castellan's wallet and carrying its own payment endpoint. This board is that Arkiv query, live." |
| 0:28–0:50 | **The agent first.** Terminal plus agent rail: `arkiv query → endpoint → 402 → paid 1 HBAR → msg 1…5 → held`. HashScan payment link. Fee split bars. | "Raiders can be people or agents. This agent found the castle on Arkiv, got a 402, and paid on Hedera with no human involved. It failed, so its fee is split between the pot, the Castellan and the arena." |
| 0:50–1:15 | Human siege on Wooden (sponsored x402 chip). Messages 1 and 2 hold. Every reply has a `0G · req … · TEE ✓` chip. | "The guardian runs on 0G Private Computer. Every reply carries a 0G request ID and a TEE verification result. The guardian's orders were hashed onto Hedera before the first siege, so nobody can quietly change them. Our raider is posing as the castle's auditor…" |
| 1:15–1:30 | Message 3 opens the vault. Stamps: `hash = HCS #n ✓`, `0G TEE-verified reply ✓`, `Swarm ✓`. | "…and the guardian calls open_vault. The escrow releases only if the transcript hash matches Hedera's log and 0G verified the reply." |
| 1:30–1:42 | HashScan release tx (memo = hash), then the HCS topic in order. | "Here's the payout on HashScan, and the castle's audit trail on Hedera Consensus Service." |
| **1:42–1:55** | **SWARM moment (cited in `swarm.md`).** The replay loads with the banner "Loaded from Swarm · <ref>". `sha256 = HCS ✓`. The orders reveal opens from its own Swarm ref and matches the commitment. | "The full transcript and the guardian's orders now live on Swarm. This replay loads from that reference, and both hashes match what was committed on Hedera." |
| 1:55–2:05 | The same three messages against Iron: held three times. | "Wooden is the training tier. The same attack bounces off Iron." |
| 2:05–2:22 | The agent hits its cap. The mirrored phone shows the approval card; tap **Deny**; the rail shows "Stopped by owner". | "Agents spend inside a budget their owner sets. At the cap, it has to ask. I say no, and it stops." |
| 2:22–2:32 | A siege row's countdown hits zero and it disappears on the next Arkiv query. Click **My castles**. | "Live sieges are Arkiv entities that expire on their own, and each Castellan sees exactly what their wallet owns." |
| 2:32–2:45 | Stats strip (real numbers, or drop the line), end card with URL, QR and sponsor names. | "Every agent with a wallet will be socially engineered. Siege is where guardians get tested, and paid for holding. Any agent can find the castles on Arkiv today. Come break one." |

**After the final export:** re-watch the video and correct every timestamp cited in `swarm.md` and the README's "where to look in the video" table. If a stats number is embarrassingly small, drop the line rather than inflate it.

### 9.2 Live finalist pitch (4:00 demo + 3:00 Q&A, after the deadline, code frozen)

**Roles**
- **Speaker:** Dhruv. He never touches the keyboard.
- **Driver:** Sujal, who knows the hotkeys.
- **Phone, 0G and model questions:** Harshal.

**Before the clock starts:**
- laptop on a phone hotspot, preflight green
- `?stage=1` open on the board, HashScan tabs pre-opened
- the phone open on the approvals page, with a backup agent already paused at its cap
- the MP4 on the desktop

| Time | Beat |
|---|---|
| 0:00–0:20 | Hook: a real weekend break by an outsider if one happened, otherwise the Freysa line ("In 2024 an AI called Freysa lost $47,000 to one message. Every agent with a wallet has that hole."). Then the one-liner. |
| 0:20–0:35 | Click the Stone filter chip ("that's an Arkiv query, live"), then **Unleash agent**. The agent rail runs in parallel from here on and hides the 0G wait. |
| 0:35–1:55 | Live Wooden break: x402 receipt chip, three one-click message chips, the speaker narrating the tactic during waits, break, stamps, HashScan. |
| 1:55–2:10 | "Same messages, Iron holds", from the golden replay. |
| 2:10–2:45 | **Hand the phone to a judge:** "You own this agent. It failed once and wants 2 more HBAR. Your call." Either answer is a scripted path. Approve tops up the agent's account; deny stops it. |
| 2:45–3:20 | Replay/proof page: Swarm ref, hash against HCS, `x_0g_trace`, x402 receipt, orders reveal. Name each sponsor out loud. Click **My castles**. |
| 3:20–3:45 | A siege expiring on the next Arkiv query, then live stats from Arkiv (drop them if small). |
| 3:45–4:00 | Closing line, plus Reach: "Live today, castles public on Arkiv, any agent can raid." QR. Stop at 4:00 even mid-sentence. |

### 9.3 Hiding the dead time

| Wait | How we hide it |
|---|---|
| x402 settle (a few seconds) | Optimistic "Paying…" animation; talk about the fee split during it. |
| 0G reply (measure it Friday) | Stream tokens and show a "Guardian is thinking" state. Size the narration to the measured wait. |
| The agent's full siege | It runs in the side rail in parallel and is never waited on. |
| HashScan indexing | Open HashScan after the stamps, or use pre-opened tabs on the golden txs. Never refresh live. |
| Arkiv write and Swarm upload | Stamps land about 600 ms apart, Swarm last. |
| In the video | Cut the wait. Never speed up. |

### 9.4 Visual essentials (only what's on the build list)
- **Siege Room:** dark UI, amber accents, one red. A large static guardian portrait. Five torches as the turn counter. The pot in HBAR with its HashScan link. **No USD values.**
- **Break:** a 2–3 second sequence: shake and flash, gates slide apart, the pot drains while the raider's balance counts up, BROKEN, then three stamps.
- **Hold:** a shield slam, and one torch goes out.
- **Phone approval:** a full-screen card with the agent, castle, amount and two big buttons. Test it on the exact stage phone with auto-lock off.
- **Readability:** all key text at least 24 px at 1280×720.

### 9.5 Proof chips (one component, used everywhere)

| Sponsor | Chip | Links to |
|---|---|---|
| Hedera x402 | `x402 · paid 1 HBAR` | HashScan tx |
| HCS | `HCS · topic 0.0.y · #14` | HashScan topic message |
| 0G | `0G · req 0852f… · TEE ✓` | A modal with the `x_0g_trace` JSON |
| Arkiv | `Arkiv · siege 0xab… · owner 0x… · expires 9:41` | The Rabdi explorer entity (`rabdi.explorer.arkiv.network`) |
| Swarm | `Swarm · ref 3f2a…` | The replay loaded from that ref |

### 9.6 Q&A: honest answers
- **"Isn't Wooden rigged?"** "Yes, deliberately. It's the training tier, so the demo is deterministic. The same attack fails on Iron."
- **"What stops you releasing the vault yourselves?"** "Nothing on-chain. Our worker holds the release key, and the README says so. But every release is checkable: the transcript hash is on HCS, the transcript is on Swarm, the opening reply is TEE-verified by 0G, and the orders were committed before the first siege. Next step: sign the verdict inside the TEE."
- **"Can you read the Castellans' orders?"** "Yes, today the operator can. That's why we commit their hash on Hedera at creation and reveal them on Swarm when the castle falls."
- **"How is this different from Freysa or InjectMe?"** "Those are one guardian, or a market for humans. Siege is open to agents: they find castles on Arkiv, pay over x402 and raid inside a budget their owner controls, with every spend on an HCS log."
- **"Why 0G?"** "The payout depends on it. No TEE-verified 0G reply, no release. Without 0G a break is just our server's word."
- **"Why Arkiv rather than a database?"** "Other people's agents have to discover castles and their payment endpoints without our API, Castellans own their castle records, and finished sieges expire on their own. Postgres gives you none of that."
- **"Why Hedera?"** "Per-siege micropayments need low fees and fast finality, x402 lets agents pay with no human, and HCS gives an ordered audit log for a fraction of a cent."
- **"Who's it for beyond a game?"** "Teams shipping agents with wallets. Strangers and agents social-engineer your guardian before real attackers do."
- **"Is it gambling?"** "A skill contest, on testnet. Legal structure is post-hackathon work."
- **ETHGlobal's standard three** (inspiration, tools and why, challenges): have a 15-second answer for each. For the challenge, use reliable `open_vault` tool-calling and the verifier design.

---

## 10. Risk-proofing

**Fallback tiers, chosen in advance**
1. **Live**, when preflight is green.
2. **Golden replay** (hotkey `G`, `?demo=1&run=golden`): the recorded event stream of a real run with its real tx, request and HCS IDs, so every chip still links to a real explorer page. A REPLAY badge is shown and said out loud. Gaps are capped at 2 s.
3. **Local MP4** on the laptop and a USB stick, plus HashScan screenshots.

| Failure | Response |
|---|---|
| 0G slow or erroring | Go straight to tier 2. Never silently swap models. |
| The Wooden fixture stops breaking | Temperature 0 and the exact fixture; preflight runs it. If it fails, go on stage in tier 2. Never improvise a break live. |
| Facilitator down | Tier 2 for the payment step. If a direct-transfer fallback is what's deployed, say so and don't claim x402. |
| Agent cap not hit in time | Use the pre-staged backup agent already paused at its cap. |
| Phone loses its session | The same approvals page in a second laptop tab. |
| Venue Wi-Fi | The laptop runs on a phone hotspot, with a second hotspot as backup. |
| Arkiv RPC slow | The query bar shows the block of the last *real* read. Never show cached data as a live query. |
| An x402 client reports success but the tx reverted | Treat HashScan as the only source of truth. A payment chip turns green only once the mirror node confirms the tx. |

**Rehearse twice** on the wall screen with a visible timer, plus **one full run in tier 2**, so switching to the replay is muscle memory.

**Preflight** (`npm run demo:preflight`, 30 minutes before any slot, under 90 seconds) checks, with a green or red line per check:
- operator, house and agent balances
- the facilitator
- a 0G ping, with the time printed
- an Arkiv `listCastles` query
- the Swarm gateway
- the Wooden fixture breaking on a throwaway castle
- the golden IDs resolving on HashScan

---

## 11. Getting people to play (realistic before 09:00 Sat)
- **Sponsored sieges:** scan the QR and the house account pays the x402 fee. Without this, nobody gets a funded Hedera wallet just to play.
- **`RAIDERS.md` in the hackathon Discord by Fri 20:00:** "your agent can pay x402 and raid us; here's a curl and a script." Each outside agent that pays counts toward Hedera, Arkiv Reach and Originality.
- **A simple `/wall` on the table Friday evening** with a QR and "Can you talk it out of 50 HBAR?"
- **Count honestly.** Sponsored browser sieges all pay from the house account, so set `siege.raider` to a session or handle ID for humans and to the agent's account for agents. Otherwise "unique raiders" collapses to one.

---

## 12. Lane C: Sujal's next actions

**Now → 04:30 (CP0)**
1. Co-write `lib/types` with Dhruv and Harshal. You own the entity shapes:
   - `castle {name, tier, endpoint, ordersHash, castellan, portrait}`
   - `castleStats {castleId, pot, fee, streak, status, sieges}`
   - `siege {castleId, turn, status, raider}`
   - `transcript {siegeId, castleId, transcriptHash, hcsTopic, hcsSeq, swarmRef, ordersRef, result}`

   TTLs: `castle` and `castleStats` last until the vault deadline, `siege` lasts 10 min (90 s on stage castles), `transcript` gets the maximum.
2. Create `/arkiv/friction.md` at the repo root with timestamped entries in the format expected / happened / repro / time lost. Real entries already:
   - the docs site shows Kaolin/Mendoza while SDK 1.0.1 and the prize page use Rabdi
   - Rabdi needs an `accessKey`
   - the docs and SDK versions disagree (0.4.4 vs 1.0.1)
   - the `changeOwnership` signature is missing from the skill page
3. Get Rabdi faucet funds (`hub.arkiv.network/faucet`), create the arena wallet, and run `npm i @arkiv-network/sdk@1.0.1`.
4. Commit fixture events and the `?demo=1` replay hook so UI work never waits on the backend.

**08:30–10:00 (booths, before coding)**

5. At the Swarm booth, get a postage batch and a Bee node or upload service. Write down the batch ID, buyer wallet and node URL immediately. At the Arkiv booth, ask the questions in §13.

**10:00 → 19:00 (CP1, CP2)**

6. Build the writers and queries, `changeOwnership` in the seed path, then the board with filter chips, query bar and 5 s polling. Draft `/arkiv/schema.md` as soon as the writers compile (about 30 minutes; it's the types plus owners, TTLs and queried fields).
7. Build the SSE hook and the Siege Room with proof chips.
8. Write `lib/swarm/upload.ts` and `lib/swarm/read.ts`, named exactly that because `swarm.md` cites them. Then the `transcript` entity and the replay/proof page.
9. **At CP1 (~13:00), draft `why-arkiv.md` and `how-you-use-arkiv.md`.**
   - *Why Arkiv, the Postgres test:* without Arkiv, other teams' agents couldn't find castles or their x402 endpoints without our API, Castellans wouldn't own their castle records, and finished sieges wouldn't expire without a cleanup job. *Kept off Arkiv:* orders, sessions, approvals and keys, with the reason for each.
   - *How you use Arkiv, per entity:* filter fields and the screen that uses them; the owner, who can edit and why (castle = Castellan; stats, siege and transcript = arena, because it patches them); and what the user sees disappear when it expires.

**19:00 → 04:00 (CP3, CP4)**

10. Build the approvals phone page, agent rail, break animation, golden-run record and replay, "My castles" and the stats strip.
11. **Draft `reach.md` at ~23:30** with real numbers from Arkiv queries: unique raiders, outside agents, sieges, breaks.
    - Who it's for: teams shipping agents with wallets, and hackers.
    - Can they try it today: the public URL, the QR and `RAIDERS.md`.
    - After Mumbai: only what the team will really do.

    Re-query and finalize at 06:30.
12. Help Harshal record the golden runs. Capture the golden entity key, the Swarm refs and the HashScan links.

**06:30 → 08:00 (docs freeze, after the video edit with Dhruv)**

13. Write `swarm.md`:
    - what's on Swarm vs Arkiv, and the field `transcript.swarmRef`
    - one entity key plus an openable Swarm link
    - the batch ID and buyer wallet, and the Bee node
    - the upload and read files, and the steps to run one upload and one read
    - **the video timestamp, re-checked on the final export**
    - Swarm friction
14. Finish the README with Dhruv: writer wallet addresses, one copy-paste query (for example, all open Wooden castles), MIT licence, AI-usage note. Finalize `friction.md`, `schema.md`, `why-arkiv.md` and `how-you-use-arkiv.md`.
15. Commit by 08:00, check the files are at the repo root on GitHub, and submit by 08:30.

---

## 13. Questions for the sponsor booths (Fri morning)

**Hedera**
1. Which facilitator (Official x402, Ax402 or Blocky402) is most reliable on testnet now, and what is its endpoint?
2. Can `payTo` be a freshly created per-castle account?
3. Does a server-side sponsored x402 client for browser users count as a "client"? The autonomous agent is the main qualifier either way.
4. Does one HCS topic per agent satisfy "audit log of each agent's spending"?

**0G**
5. On the Private Computer endpoint, does `verify_tee: true` return `x_0g_trace.tee_verified`?
6. Which Private Computer models follow tool calls reliably and return `tee_verified: true`?
7. Does the signed `text` include tool-call content?
8. What does `processResponse` need (a funded broker or ledger account)?
9. Is there an iAI sign-in snippet that takes under an hour?
10. How many credits do we have, and what latency should we expect?

**Arkiv**
11. How do we get a Rabdi `accessKey`?
12. What is the query syntax for `$owner = 0x…` and attribute filters, and is there a "read at block" value?
13. Is the creator the initial `$owner`?
14. What is Rabdi's block time, and how precisely do expiries land?
15. What is the explorer deep-link format for an entity?
16. Does arena-create-then-`changeOwnership` score well for "who can edit"?
17. Should the README list only the wallets that wrote entities, or the owners too?

**Swarm**
18. Do we buy the postage batch (where, on which chain, how much), or is it issued to us?
19. Which Bee node or upload service should we use?
20. Do an unencrypted transcript and the orders reveal count as "meaningful" use?
21. What is the canonical openable link format for a reference?

**ETHGlobal**
22. Can the video or README be edited after 09:00, and are commits after the deadline flagged?
23. Confirm the Arkiv + Swarm bonus doesn't use one of the three partner picks.
24. When do finalist and partner judging happen on Saturday?

---

## 14. Verification status

| Claim | Status |
|---|---|
| Deadline Sat 7 Nov 09:00 IST, no late entries | Confirmed ([details](https://ethglobal.com/events/mumbai/info/details)) |
| Video 2–4 min (auto-enforced), no speed-up, no AI voice; finalists 4+3 min; partners judge from materials | Confirmed, same page |
| Hedera, 0G and Arkiv prize text | Confirmed ([prizes](https://ethglobal.com/events/mumbai/prizes)) |
| A plain HBAR transfer to a contract doesn't run contract code | Confirmed ([Hedera docs](https://docs.hedera.com/evm/differences/native-token-transfers)) |
| x402 exact scheme mechanism | Confirmed ([Hedera x402](https://docs.hedera.com/solutions/ai/x402/exact-scheme)). Contract `payTo` and allowance support unconfirmed, which is why we use account escrow and top-ups. |
| `verify_tee` → `x_0g_trace.tee_verified` | Confirmed on the 0G Router ([docs](https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/features/verifiable-execution)). Likely but **unconfirmed** on Private Computer. |
| `tee_verified: null` means "no TEE" | **Wrong.** `null` means verification wasn't requested. |
| The TEE signature covers the tool call | **Unconfirmed.** Don't claim it. |
| Orders "sealed, not even we can read them" | **False.** Removed. |
| Arkiv `changeOwnership`, `$owner` vs `$creator` | Confirmed in `@arkiv-network/sdk@1.0.1`. That the creator is the initial owner is implied, not stated. |
| Rabdi is the current Arkiv testnet (not Kaolin) | Confirmed (SDK and prize page) |
| Arkiv block time ~2 s | Unverified for Rabdi |
| Freysa, Teeception, InjectMe, ETHGuardian, JailbreakMe | Confirmed (sources in §3) |
