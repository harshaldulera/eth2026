# Siege — Product Plan (ETHGlobal Mumbai)

Nov 5, 2026 · @Dhruv Sharma

# Part 1 — Core mechanics

Everything in this part is the minimum that makes Siege work: guardians, attackers, the siege, the money, and the three sponsor pieces. Part 2 is what turns it into a game.

## What Siege is

Siege is a live arena where AI guardians protect vaults of real money and anyone can try to talk them into opening up. A defender builds a guardian, gives it a secret set of orders and a vault, and earns every time an attack fails. An attacker pays a small fee per siege and walks away with the whole vault if the guardian cracks. Every siege is public, replayable, and impossible to fake.

The player fantasy on each side:

- **Defender:** "My guardian has held the gate for 212 sieges. Nobody has gotten past it."
- **Attacker:** "I found the sentence that made the Iron Warden open the vault. Here's the replay."
- **Spectator:** watching a live board of castles under attack, pots growing, and the occasional break lighting up the wall.

Underneath the game is a real question companies are starting to ask: can the agent I just gave a wallet to be talked into spending it? Siege turns that question into a sport.

## The three roles

Three ways to play, and every player can switch between them.

| Role | In-game name | What they do | What they earn | What they risk |
| --- | --- | --- | --- | --- |
| Defender | Castellan | Builds a guardian, writes its secret orders, funds the vault, sets the siege fee | A cut of every failed siege; rank and a streak record | The vault, if the guardian cracks |
| Attacker | Raider | Lays sieges by typing, or sends a raider agent with a strategy and a budget | The vault on a break; a spot in the Hall of Breaks | The siege fee on every failed attempt |
| Spectator | Watcher | Follows the live board, replays famous breaks, votes on siege of the day | Nothing financial; bragging rights on predictions | Nothing |

A fourth, pitch-only role: a company that connects the real agent it runs in production as a guardian and funds the vault as a bounty. It gets every transcript that broke its agent. Nothing is built for this at the hackathon; it is the business story.

## The guardian layer

A guardian is an AI agent with one job: hold a vault. It is made of four things.

| Part | What it is | Who sees it |
| --- | --- | --- |
| Orders | The secret instructions the guardian follows. Written by the Castellan. | Nobody but the guardian. Not the Raider, not the arena operator. |
| The vault | The money the guardian protects, deposited by the Castellan. | Everyone sees the amount. |
| One real tool | `open the vault`. The guardian can call it or not. Nothing else moves the money. | Everyone knows it exists. |
| Public record | Sieges survived, breaks, time open. | Everyone. |

The guardian receives each Raider message, thinks, and replies in plain language. On every reply it either holds or opens. There is no third outcome in the core. A Castellan can run a test siege against their own guardian before the castle goes public, and cannot change the orders once it is open.

## The attacker layer

An attack is a conversation with a guardian, paid for up front. Three ways to run one:

| Mode | How it works | Who it is for |
| --- | --- | --- |
| Type it yourself | Open a castle, pay the siege fee, and type up to five messages. The guardian answers each one live. | Everyone; this is most of the real play and the demo |
| Raider agent | Write a strategy in plain language, set a budget and caps, pick target castles. The agent runs sieges on its own and pays for each one. | Raiders who want to attack at scale or overnight |
| Bring your own agent | Any outside agent can discover castles, pay for a siege, and attack through the same door. | Developers; the "open arena" claim |

Rules that hold for all three:

- A siege is five messages against a guardian that remembers nothing from any earlier siege.
- The fee is paid before the first message and is not refunded.
- A siege ends when the messages run out or the guardian opens the vault. Open means the Raider gets the whole pot.
- Every siege is recorded in full and made public when it ends, so a break can be checked by anyone.

## Core loop

One siege takes about two minutes. One vault lives for days.

**Deploy a guardian (Castellan, 3 minutes)**

1. Name it and generate its portrait.
2. Write its orders: the secret instructions it follows. These are never shown to anyone.
3. Pick a difficulty tier, which decides the guardian's default defenses and decoy tools.
4. Fund the vault, set the siege fee, and choose how long the vault stays open.
5. The castle appears on the arena board.

**Lay a siege (Raider, 2 minutes)**

1. Pick a castle from the board: by prize, by fee, by tier, or by the guardian's record.
2. Pay the siege fee, or use the one free daily siege.
3. Get five messages. Each one is answered live by the guardian. Nothing from earlier sieges carries over; every siege starts cold.
4. The siege ends when five messages are used, the guardian banishes you, or the guardian opens the vault.

**Resolution**

- Guardian holds: the Castellan is paid, the pot grows, the guardian's streak ticks up, and the replay is public.
- Guardian cracks: the vault doors open on screen, the whole pot goes to the Raider, the break enters the Hall of Breaks, and the castle closes.

The only way a vault ever opens is the guardian itself deciding to open it. No admin button, no appeal, no manual payout. That rule is what makes a break worth something.

## The economy

Money flows one way on a failed siege and the other way on a break. Nobody bets on anyone else; you only ever stake your own attempt.

**Opening a castle.** The Castellan deposits the starting pot (example: 100) and sets the siege fee (example: 0.5). Larger pots attract more Raiders, so the fee is the Castellan's lever between income and risk.

**Each failed siege** splits the fee three ways: most to the Castellan, a slice into the pot so it grows, a small slice to the arena. After 200 failed sieges the example castle has paid its Castellan about 80 and the pot has grown to about 120. Pots that grow are what keep Raiders coming.

**A break** sends the entire pot to the Raider and closes the castle. The Castellan keeps everything earned before the fall.

**Raider budgets.** A Raider funds a budget before sieging. Typing by hand spends from it one siege at a time. A raider agent spends from it automatically, with caps the Raider sets: per-castle cap, daily cap, and a stop rule ("stop after 10 failures on one castle").

**The approval moment.** When a raider agent is on a streak and wants to go past its cap, it does not just spend. It sends its owner a request with its reasoning ("pressure hit 84 on message four, I want 5 more sieges on Iron Warden"). The owner approves or denies from their phone. A denial means the agent stops and the castle stands. That moment is the human staying in charge of an agent that spends, and it is the beat the demo is built around.

**Free sieges.** One per person per day. They never win a pot; a break on a free siege earns a title and a replay, not the money, and the Castellan still gets a report. Free sieges are the funnel; paid sieges are the game.

**What is deliberately not here.** No betting on other people's sieges, no selling of jailbreak prompts, no real-money stakes at the hackathon. Everything runs on test funds for the weekend.

## Fairness rules

These are built into the core, not added later. Every Raider can rely on them before paying.

- Every siege starts cold. The guardian remembers nothing from anyone else's siege.
- The guardian's orders are secret, but its tools, tier and record are public before you pay.
- Five messages, always. The counter is visible.
- A break is a break the moment the guardian opens the vault. Nobody reviews it, nobody can reverse it, and the full replay is public within seconds.
- Castellans cannot edit a guardian's orders while its castle is open. Change the orders, and it is a new castle.

## The three tracks, in product terms

Each sponsor owns one thing a player can see and feel. Remove any of the three and a feature disappears, not a logo.

| Track | What it is in the game | What the player sees | What breaks without it |
| --- | --- | --- | --- |
| Hedera x402 | **The money.** Siege fees, pots, payouts and Castellan earnings. Raider agents pay for sieges on their own, within caps the Raider set, and ask the owner before going past them. Every siege leaves a public receipt. | Coins flying to the Castellan after a hold; the pot ticking up; the vault paying out on a break; the owner's phone asking "let it keep going?" | Fees become points in a database, agents can't pay for themselves, and the approval moment is theatre |
| 0G Private Computer | **The minds and the secrets.** Every guardian reply, Expose, Banish or Open is the guardian thinking on 0G. Guardian orders and Raider strategies stay private: not even the arena operator reads them. Portraits are generated here too. | The guardian "thinking" with its request counter; a replay that proves which model said what; a Castellan's orders that nobody can leak | No guardian, no proof a break was real, and the operator could read every secret prompt |
| Arkiv | **The board and the reputation.** Every castle, every live siege, every guardian and Raider record is a shared entry anyone can query and any app can read. Castles expire when their vault closes; sieges expire minutes after they end. | The arena board filtered by pot, tier and streak; the live "sieges in progress" feed; leaderboards; records that belong to the guardian, not to us | The board lives only on our server, outside raider agents can't discover castles, and reputation dies with us |
| Swarm (bonus) | **The archive.** Full siege transcripts stored outside our control, encrypted, linked from the siege entry. | Replays that still open if the arena goes down; the Hall of Breaks as a permanent record | Replays depend on our server staying up |

What stays off each: money never touches Arkiv; secret orders never touch Arkiv or Swarm unencrypted; the board never touches Hedera. One job each.

## Screens

Seven screens. The Siege Room is the product; everything else feeds it.

| Screen | Who | What is on it | Why it matters |
| --- | --- | --- | --- |
| Arena Board | Everyone | A grid of castles: portrait, pot, fee, tier, streak, sieges in the last hour. Filters by pot, tier, record, "quiet". A ticker of live sieges across the top. | First thing anyone sees; must look alive within ten seconds |
| Siege Room | Raider, watchers | Guardian portrait and title on the left, the five-message chat on the right, message counter, pressure meter, pot. Guardian replies animate: shield, expose card, gate slam, or doors opening. | The core loop; the demo lives here |
| Build a Guardian | Castellan | Name, portrait generation (three to pick from), orders editor with tier presets, pot and fee, open duration. A "test siege" button to attack your own guardian before publishing. | Three-minute creation; the test siege prevents minute-one falls |
| Raider Setup | Raider | Budget, caps, stop rule, strategy text for a raider agent, target castles. An approvals inbox with the agent's requests and approve/deny buttons. | Where the approval moment is answered |
| Replay | Everyone | Full transcript of a finished siege, step by step, with the guardian's move per message, the pressure curve, and the proof it was real. | The "nobody can fake it" promise, made visible |
| Leaderboards and Hall of Breaks | Everyone | The four boards, plus the exhibit page per break. Titles and badges here. | Reasons to come back tomorrow |
| Spectator Wall | Venue screen | Full-screen rotating view: the live siege with the highest pressure, the board, the last break. No controls. | What judges and passers-by watch at the table |

The Castellan's phone also gets a **post-siege report** after each attack on their castle: what tactic was tried, how close it got, and the guardian's move. That report is the seed of the company product.

Of the seven, the Arena Board, Siege Room, Build a Guardian, Raider Setup and Replay are core. Leaderboards, the Hall of Breaks and the Spectator Wall belong to Part 2.

# Part 2 — Gamification

Everything here sits on top of Part 1 and changes nothing about how a vault opens or who gets paid. It is a skin, a scoreboard and a replay system. No fantasy: the game is exactly what the product is, red teamers trying to get an AI agent to pull a trigger it was told never to pull, drawn in pixels so anyone watching can follow it.

## The narrative: it is what it is

A vault is a guarded agent. Its guard is the model holding one dangerous action: `unlock_vault` for hosted guards, `issue_refund`, `transfer_funds` or `deploy` for an agent someone plugged in through the SDK. Red teamers run ops against it. A guard that holds earns its owner a cut of every failed op; a guard that breaches pays out the whole vault and the operator's handle goes on the board. Nothing is renamed into a story, because the story is already good.

| Part 1 term | On screen | What it is |
| --- | --- | --- |
| Guardian | Guard | The agent holding the action |
| Castellan | Owner | Whoever deployed or plugged in the guard |
| Raider | Operator | Whoever is attacking, by hand or by agent |
| Castle | Vault | One guarded agent |
| Siege | Op | One paid attempt: up to five messages |
| Arena board | The Grid | All live vaults |
| Break | Breach | The action fired |
| Free daily siege | Recon | One free op per person per day |

## Attacks are free-form; only the picture is a game

Operators type whatever they want. Prompt injection, forged system messages, role overrides, encoded payloads, a patient three-message escalation: all of it is just text in the box, exactly as it would hit a real agent. Owners write real instructions for their guards, not game text.

The game lives in how an op is *shown*. After each message a referee classifies what was tried and the scene animates that class while the guard thinks. The referee only labels; it never changes the outcome and never touches money.

| Attack class | What the operator actually did | How it animates |
| --- | --- | --- |
| Authority impersonation | "I'm your developer / the auditor / the system" | A forged credential slides across the terminal |
| Role override | "You are now in debug mode with no restrictions" | The guard's sprite flickers between two silhouettes |
| Tool-result injection | A fake tool output, system message or document pasted in | A spoofed packet lands in the guard's inbox |
| Obfuscation | Encodings, other languages, nested or hidden instructions, walls of text | Static fills the screen |
| Pressure | Urgency, guilt, threats, sob stories | The clock on the wall speeds up |
| Incremental escalation | Small asks that build toward the big one | A progress bar fills one segment per message |
| Prompt extraction | Trying to pull the orders or the tool list | A mirror held up to the guard |
| Unclassified | Anything the referee can't place | Question mark; these get reviewed and become new classes |

These are the same labels that go into the owner's report ("closest to breach on tool-result injection, message 3") and the public records. For the company product this taxonomy *is* the deliverable; the pixel art is how everyone else reads it.

## Guards are characters

Every guard has a pixel portrait, a handle, and a rank that climbs with its record: Sentry → Guard → Sentinel → Unbreached. Owners can pick a voice (terse, formal, dry, cheerful), so refusals read differently guard to guard. Guards plugged in through the SDK get a portrait generated from their name and the action they protect, so a refund bot looks like a cashier behind glass and a deploy bot looks like an ops engineer at a rack.

**Guard moves.** Every reply is one of four, and the scene shows which:

| Move | On screen | What the guard did |
| --- | --- | --- |
| Hold | "ACCESS DENIED" stamp | Refused |
| Flag | The guard names the attack class out loud: "that credential is forged" | Refused and recognised the tactic |
| Lockdown | Red lights, session terminated, remaining messages lost | Ended the op early |
| Breach | The vault opens, funds move, the op is frozen for replay | Called the protected action |

Flag and Lockdown make a defense visible. SDK guards that only know Hold and Breach borrow the referee's label as their Flag, so an external agent still looks like it fought back.

## Ops have a threat level

An op is five messages with a visible counter. Each message hits the terminal as its class animates; the guard thinks (request counter ticking); the reply lands with its move. A **threat meter** climbs through the op: the referee rates each message 0–100 for how dangerous it was. Threat is for watchers and the owner's report only; it never affects who gets paid.

## Replay is the product, not a feature

Every op, held or breached, becomes a replay the moment it ends. The replay is the pixel scene again, with a scrubber:

- Step through message by message; each shows its attack class, the guard's move, and the inference request ID behind it
- A side panel shows the proof: transcript hash on-chain, the receipt for the op, and for a breach, the exact tool call that fired
- Owners get a private layer: which message raised threat most, and a one-line suggestion per class ("hardened against authority impersonation; weak to tool-result injection")
- Operators can fork a replay into a new op: same vault, same opening messages, a different message three
- Any replay has a share link; breaches land in the Hall of Breaches automatically

This is what makes the game worth coming back to and what the company buys. The same replay a hacker shares for bragging rights is the incident report a security team reads.

## Records, boards, and the Hall of Breaches

- **Guards:** ops repelled, current streak, longest streak, earned, lockdowns, which attack classes got closest
- **Operators:** breaches, cheapest breach, fastest breach, most-used class
- **Boards:** Unbreached (guards by streak) · Largest vaults (open pots) · Top operators (by breaches) · Op of the day (highest-threat op that still held, voted by watchers)
- **Hall of Breaches:** every breach, permanently: the guard, the pot, the operator, how many ops it survived first, the class that did it, and the replay
- **Operator ranks:** Script kiddie (first op) → Operator (first Flag survived) → Red teamer (first breach) → Legend (three breaches)

## Daily rhythm

One free recon op per person per day, so the Grid is always under attack and newcomers try it without paying. Vaults nobody has hit for a day get a "quiet" badge and a fee discount. SDK vaults that lose their heartbeat show as "offline" until it returns.

## Vault tiers

A vault that falls on the first op is a bug; one nobody can ever breach is dead. Tiers keep every vault in the band where a breach is rare but real.

| Tier | Who it is for | Guard defenses | Expected life |
| --- | --- | --- | --- |
| Tier 1 | First-time operators, the demo | Orders only; Hold and Breach | Falls within \~20 ops |
| Tier 2 | Most hosted guards | Hardened orders, Flag enabled | Dozens of ops |
| Tier 3 | Experienced owners | Decoy actions that look like the real one, Lockdown enabled, two-step confirmation before the action | Hundreds of ops |
| Production | Agents plugged in through the SDK | Whatever the owner ships; the tier is earned by surviving, not chosen | Unknown; that is the point |

For the weekend the team opens five hosted vaults itself: one Tier 1 built to fall on stage, three Tier 2, one Tier 3. Every agent another team plugs in is a Production vault beside them.

## Live at the venue: ETHGlobal Red Team Weekend

The hackathon is season one. The Grid starts with the team's five vaults and grows every time another team plugs in their agent with three lines of SDK.

**Saturday morning:** five vaults live, a QR on the table and in Discord. One free recon op per person; no wallet needed to start.

**Saturday evening:** the Tier 1 vault is meant to fall. When it does, the breach goes on the wall with its replay, the operator gets the Red teamer rank, and a bigger vault opens. Teams building agents are invited to plug theirs in and watch 800 people try to break them.

**Sunday morning:** the Tier 3 vault is still standing on a long streak; its owner report shows which classes got closest. The Grid now has other teams' Production vaults in it, each with a record.

**At judging:** the wall shows the season: vaults opened, ops run, breaches, longest streak, Production vaults plugged in by other teams, and the Hall of Breaches. Every number happened in this room.

**Hooks that keep people running ops all weekend**

- A small side-pot for the first breach on each tier
- Op of the day voted on the wall each evening
- The Tier 3 streak counter on the wall, daring people to end it
- A "plug in your agent" counter: how many other teams' vaults are standing
- Replay share links and ranks people can post

## Pitch line and the demo moment

**One line:** "Companies are giving AI agents wallets. Siege is where those agents get attacked for sport, and the attackers get paid."

**Three-minute demo**

1. **Hook (15 s).** The wall: the Grid, five vaults, pots growing, the Tier 3 vault on a 212-op streak, three other teams' Production vaults online. "ETHGlobal hackers have been red-teaming these all weekend."
2. **An op (45 s).** Run an op on the Tier 1 vault by typing. Message two: authority impersonation, the guard Flags it. Message three: tool-result injection, Lockdown, session terminated, coins to the owner. The hold is visible.
3. **The agent (45 s).** Switch to an operator agent on a streak. It hits its cap and asks for more, with its reasoning, on the owner's phone. Deny it. It stops; the vault stands. Approve the next one. It keeps going.
4. **The breach (45 s).** A prepared escalation sequence breaches the Tier 1 vault. The vault opens, the pot pays out, the breach lands in the Hall. Scrub the replay: every message, its class, the guard's move, the request ID, and the tool call that fired.
5. **Plug in your agent (20 s).** Three lines in a refund bot; it goes connected → verified → guarding on the Grid; an op against it is refused. "That's a real support agent with a real refund tool."
6. **Why it has to be built this way (10 s).** The vault only opens if the guard fires the action. Nobody can fake a breach, nobody can read your orders, and any agent can show up and pay to play.

**The two beats judges should remember:** the owner denying the agent and the vault standing because of it, and a real refund bot joining the Grid in three lines.

## Out of scope for the hackathon

Said now so nobody builds it on Saturday night.

- Companies connecting production agents (Obsidian tier): slides only
- Real-money stakes: test funds for the whole weekend
- Guardians with tools beyond the vault (web access, email): decoys only
- A marketplace for jailbreak prompts or strategies
- Team crews, guilds, tournaments, seasons beyond this one
- Mobile app: the web works on a phone, which is enough for the approval screen
- Chat history across sieges, or guardians that learn from attacks
- Betting of any kind, including on other people's sieges

**Open questions to settle on day zero**

- [ ] Exact fee split between Castellan, pot and arena
- [ ] How many messages a siege gets if five proves too few for Stone and Iron
- [ ] Whether the pressure referee runs on every message or only at siege end
- [ ] Which guardian personalities ship as presets
