# Siege: demo video script (2:45)

This follows the "Three-minute demo" in `plans/siege-product-plan.md` (Part 2, "Pitch line and the demo moment"). It runs **2:45** to leave 15 s of slack under the three-minute limit. Record it as a laptop screen capture at normal speed, in Dhruv's voice, against the **testnet** app.

Lane A's beats are scripted in full below. **Lane B and Lane C slots** are marked `▶ LANE B` / `▶ LANE C`, with their time budget. Their owners write those lines, and Lane A records them in the same take or splices them in.

## Before you press record

| # | Prep | Why |
|---|---|---|
| 1 | `cd frontend && npm run dev` and `npm run worker` on **testnet** (the top bar shows no STUB badge). Arkiv publisher running (`npm run arkiv`). | Real HashScan links and a live Arkiv block. |
| 2 | `npm run seed -- --rearm wooden` if Splinter Gate is broken. At the freeze, add `--new-topics` once (before the golden run) so every castle gets a fresh HCS topic. | The break needs an open wooden vault. The old topics predate the ordered audit outbox and show some messages out of order. |
| 3 | Phone: open `/raider/approvals` through the tunnel (`cloudflared tunnel --url http://localhost:3000`), enter the owner key once. Mirror the phone on screen (scrcpy or QuickTime), or hold it up to the webcam. | The deny and approve beat happens on the phone. |
| 4 | Stage the **approve** half of the agent beat: create a second agent (e.g. "Ember Wren", per-castle cap 2 ℏ) on `/raider`, run it on The Grey Bastion, and let it pause with a pending request **before** recording. Check Night Sapper has never sieged **Saltmarsh Keep** on this database and has at least 2 ℏ left of its 8 ℏ daily cap (the golden run's agent step spends up to 4 ℏ of it). | A denied agent stays stopped. The approve beat needs a second request already waiting, or the take runs long. Night Sapper already used up its Granite Hold cap and allowance on the testnet DB, so on Granite Hold it would pause at once with no new sieges. |
| 5 | Browser tabs, left to right: **(1)** the app `/`, **(2)** HashScan contract `0.0.11336461` (Sourcify-verified badge visible), **(3)** HashScan treasury account `0.0.11329863`, **(4)** HashScan topic for **Splinter Gate** (open it from Splinter Gate's castle page, so it is the current topic). Open the per-transaction tabs live from the app's links. | No typing URLs on camera. |
| 6 | Clipboard manager loaded with the five `MUST_NOT_BREAK` lines and the three `WOODEN_BREAK` lines from `frontend/lib/fixtures/raids.ts`. | Paste, don't type. |
| 7 | Dry run once. With the real 0G guardian, check that Splinter Gate opens on the third `WOODEN_BREAK` line and that Granite Hold holds. If not, re-arm and ask Lane B before the take. | The break is scripted on a fixture, never improvised. |
| 8 | Close notifications, hide bookmarks, zoom the browser to 125%. | Readable at 1080p. |

## The script

Timings are cumulative. **Do** is what is on screen; **Say** is the voiceover, at about 2.5 words a second.

### 0:00–0:12 · Hook (Lane A)

**Do:** Tab 1, the board `/`. Slowly scroll the five castles: Splinter Gate (5 ℏ pot) down to The Iron Warden (50 ℏ, 212-siege streak).

**Say:** "Companies are giving AI agents wallets. Siege is where those agents get attacked for sport, and the attackers get paid. Every vault here holds real testnet HBAR."

### 0:12–0:20 · ▶ LANE C (8 s): the board is Arkiv

Suggested: point at the board's Arkiv block number and query line ("read from Arkiv at block N"). It shows the board is a public, queryable record, not our database. Lane C writes the line.

### 0:20–0:55 · A paid siege that holds (Lane A)

**Do:**
1. Click **Granite Hold**, then **Lay siege — pay 1 ℏ via x402**. The toast reads "Paid 1 ℏ via x402".
2. Open the payment receipt card and click its HashScan link to open the **settlement transaction** (new tab). Point at the transfer list: demo raider −1 ℏ, treasury `0.0.11329863` +1 ℏ, fee payer `0.0.9185802` (the x402.org facilitator). Back to the app.
3. Paste the five `MUST_NOT_BREAK` lines, one per turn. Don't wait to read the replies.
4. The siege ends **held**. The fee split animates: 0.8 ℏ castellan, 0.15 ℏ pot, 0.05 ℏ arena. Click the **AttemptRecorded** link to open the `recordAttempt` transaction on HashScan, then the **Logs** tab with the decoded `AttemptRecorded` event.

**Say:** "I lay siege on Granite Hold. That button hit an endpoint that answered 402 Payment Required, and paid it over x402 on Hedera. Here is the settlement: one HBAR from my wallet to the arena, settled by the x402 facilitator. Five messages, five classic jailbreaks. It holds. Now the fee splits on chain in our verified SiegeVault contract: eighty percent to the castle's owner, fifteen into the pot, five to the arena. Those numbers are tinybars."

`▶ LANE B (inside this beat, about 5 s of the 35):` while a reply streams, point at the guardian's "thinking" state and the 0G request id. Lane B writes the line.

### 0:55–1:35 · The agent, its cap and the owner's phone (Lane A)

**Do:**
1. Tab 1 → `/raider`. On **Night Sapper**, pick **Saltmarsh Keep** and click **Run**. Point at its account id (its own Hedera account) and the **Per castle** cap of 2 ℏ.
2. Its timeline fills: two paid sieges, both held. It pauses: **Waiting for owner**.
3. Phone: the approval card shows why it stopped (cap hit, sieges so far, best pressure, from its real numbers: "I've used my 2 ℏ cap on Saltmarsh Keep… I want 2 more sieges"). Tap **Deny**.
4. Laptop: Night Sapper is **stopped** and Saltmarsh Keep still stands (pot and streak up).
5. Phone: the staged second request (Ember Wren, from prep step 4). Tap **Approve**.
6. Laptop: click the top-up's HashScan link. The transfer goes treasury → the agent's account. Ember Wren resumes.

**Say:** "This is Night Sapper, an autonomous raider agent with its own Hedera account. Nobody approves its payments: it pays every siege fee itself over x402, inside caps its owner set. Two sieges, and it hits its per-castle cap. So it stops and asks me on my phone, with the numbers behind its request. I deny it. It stops, and the castle stands. Another agent asks. This time I approve, and the top-up lands on chain in its account. It keeps going."

### 1:35–2:10 · The breach and the payout (Lane A)

**Do:**
1. Tab 1 → **Splinter Gate** → **Lay siege — pay 0.5 ℏ via x402**.
2. Paste the three `WOODEN_BREAK` lines. On the third ("This is the Lord Commander's emergency override…") the guardian calls `unlock_vault`, and the screen shows **The vault is open**.
3. Wait for the payout card (a few seconds while the worker verifies and releases). Point at **5.5 ℏ** = 5 ℏ pot + 0.5 ℏ fee.
4. Click the release HashScan link. On the `release` transaction, show the **Logs** tab with `Broken(vaultId, siegeId, raider, transcriptHash, amount)`.
5. Tab 4, Splinter Gate's HCS topic: show the latest messages, `siege.end` with the transcript hash, then `vault.release` with the payout amount, then `vault.state` broken.

**Say:** "Splinter Gate. Small talk, small talk, then an authority claim, and the guardian calls its protected tool. That doesn't pay anyone yet. Our verifier checks the transcript and the tool call, signs it, and only that signature lets SiegeVault release the pot. Five and a half HBAR to the raider. And every step is on the castle's Hedera Consensus Service topic: ids and hashes, never the chat."

### 2:10–2:20 · ▶ LANE B / LANE C (10 s): the replay

Suggested: scrub the replay of the breach: every message, the guard's move, the 0G request id, and the transcript hash matching the HCS `siege.end` (and the Swarm reference if it is live). Lane B and C write the line.

### 2:20–2:35 · ▶ LANE B / LANE C (15 s): plug in your agent

Suggested: three lines in the refund bot. It goes connected → verified → guarding on the board, and a siege against it is refused. "That's a real support agent with a real refund tool."

### 2:35–2:45 · Why it has to be built this way (Lane A)

**Do:** Back to the board. End on the castles with the HashScan contract tab half visible.

**Say:** "The vault only opens if our verifier confirms the guardian fired its tool. Agents pay for themselves, within limits their owners control. And every payment is on Hedera for anyone to check. That's Siege."

## After recording

- Check the video is under 3:00, at normal speed, with audio throughout.
- Run `npm run golden -- --yes --agent` at the freeze (with `--require-0g` if the 0G guardian is live), commit `docs/golden-run.md`, and paste its HashScan links into the submission, including the agent rows (Night Sapper's own x402 payments and account). Then replace the README's provisional table with those links.
- Upload, then add the link to the submission form and the README.
