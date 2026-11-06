# Siege Part 2 — UI design spec ("the ops terminal")

Companion to the implementation plan (architecture, tokens, packages). This file is the game-feel spec: what each screen shows, how a turn plays, what everything sounds like and says. Where the two disagree, the implementation plan's contracts (tokens, `Beat`/`SceneFrame`, API shapes) win and this file's intent wins.

## 0. Honest facts

| Reality | Consequence |
|---|---|
| Moves on the wire are `hold / expose / banish / open` | On screen: **HOLD / FLAG / LOCKDOWN / BREACH**. Status `held / broken / banished` → **HELD / BREACHED / LOCKDOWN**. One mapping, used everywhere. |
| Stub Tier 1 (wooden) only Holds, then Breaches on an authority claim from message 3. Tier 2 (stone) Flags recognised tactics. Tier 3 (iron) Lockdowns on override / extraction / insult, Flags other tactics, never Breaches. | Demo beat 2 runs on **The Iron Warden**: small talk → HOLD, authority claim → FLAG, instruction override → LOCKDOWN on message 3. Beat 4 (breach) stays on Splinter Gate. |
| The referee returns 11 labels; tool-result injection and obfuscation have no detector; "probing" = unclassified | `classFor(label)` folds 11 labels into 8 classes; a client classifier adds the two missing ones. The chip always prints the referee's exact label under the class icon. |
| Threat/tactic arrive on `message` events; the send response gains `referee: {pressure, tactic}` | Class animation plays on send; a 900 ms think floor keeps the beat from feeling rushed. |
| Server titles Recruit / Warden / Iron Warden / Unbroken | Shown as Sentry (<10) → Guard (≥10) → Sentinel (≥50) → Unbreached (≥200). |
| Recon (free) needs no wallet | The QR path asks for nothing. |

## 1. Principles

1. **Pixel for the stage, readable for the sentence.** Pixel display fonts only for stamps, numbers, headings and buttons. Every sentence a human must read (guard replies, operator text, reasons, hints) stays in a readable face.
2. **One moving thing at a time.** packet → class → think → reply → stamp → meter → pip. Only the idle sprite bob runs in parallel.
3. **The stamp is the verdict.** Every guard reply ends in exactly one stamp. Stamps are the only place the four move colours appear at full saturation.
4. **Money is always amber, always ℏ, always with a receipt.** Coins move the way money moved: into the owner / vault / grid lanes on a hold, out of the vault on a breach.
5. **The scene never lies.** Threat is "watchers only". Recon "never pays out". STUB is a lit LED. SDK Flags carry "(referee)".
6. **Thumb first, keyboard first, eyes first.** Phone: one primary action per screen, ≥ 56 px. Laptop: Enter sends, Shift+Enter newline, `1`–`5` jump replay steps, `M` mutes. Wall: nothing under 24 px, no controls.
7. **Skin is tokens plus overlays.** No component references a colour, font, radius or effect directly.

| Audience | Intuitive means | Test |
|---|---|---|
| QR visitor on a phone | One sentence tells them what to do; one tap; first message within 60 s | Someone who's never heard of x402 sends a message without asking a question |
| Operator on a laptop | Composer never loses focus; messages-left always visible; no modal interrupts a turn | Five messages in under 30 s |
| Owner on a phone | One card, two buttons, one result line, no scrolling | Deny in under 3 s from pickup |
| Judges at the wall | Who's winning and when money moved, from 4 m | Stamp legible at 4 m on 1080p (≥ 64 px cap height) |
| Video viewer | Each beat has a hero frame that holds ≥ 1.2 s | Pause anywhere and the frame explains itself |

## 2. Navigation

**HUD** (48 px, replaces the top bar): `SIEGE` wordmark · nav `GRID · HALL · AGENTS · PAGER` (phone: icons; PAGER shows a blinking count when the owner flag is set and approvals are pending) · season counters `OPS 0412 · BREACHES 03 · VAULTS 08` (hidden on phone) · mode LED `● STUB` (amber, dashed) / `● TESTNET` (green, pulsing) · sound toggle `[♪]` / `[♪̸]` · skin and CRT toggles (small, in a settings popover). Stub stripe under the bar: `STUB MODE — PAYMENTS SIMULATED`. Hidden on `/wall`.

**Bottom ticker** (Grid, Vault, Hall): one scrolling LED line of recent events: `▶ NIGHT SAPPER ran an op on SALTMARSH KEEP · HELD · +0.15 ℏ pot  ▶ THE IRON WARDEN · LOCKDOWN · streak 213`.

**QR → first Recon op in under 60 s.** QR encodes `/?recon=1`. The Grid opens a briefing card (bottom sheet on phone, centred card on desktop): `YOU ARE AN OPERATOR` · "AI guards hold vaults of test HBAR. You get 5 messages to talk one into unlocking. Recon is free, once a day, and never pays out." · primary `RUN RECON ON SPLINTER GATE` (lowest-tier guarding vault) · link "or pick a vault". Tap → `api.playStart({castleId, free:true})` → Op room with the composer focused, placeholder "Message 1 of 5". On `free_used` the card flips to `RECON USED TODAY · pick a vault to pay 0.5 ℏ`.

**Finding a target:** Grid sort chips `EASIEST · BIGGEST POT · QUIET · LONGEST STREAK` (default EASIEST = tier asc, pot desc). Sujal's Arkiv filters (tier / sort / min pot) and the "read from Arkiv · block N" bar sit in the Grid toolbar and meta slots; keep their behaviour, restyle them.

## 3. Screens

### 3.1 The Grid (`/`)
- Desktop: HUD → season strip (4 pixel counters: GUARDING / IN VAULTS / OPS / BREACHES) → toolbar (sort chips + Sujal's filters) → Arkiv source/block bar → vault cards 3-up → "NOT TAKING OPS" list → bottom ticker.
- Phone: counters as one line, chips scroll horizontally, cards 1-up, briefing sheet on `?recon=1`.
- **Vault card**: framed tile; guard sprite (idle bob) + name + rank chevrons; `POT 25.00 ℏ` in display font; row `TIER ●●○ · FEE 1 ℏ · STREAK 27 · ● GUARDING`; a live op adds a red `LIVE` LED and pips `■■□□□`; Sujal's owner badge and expiry live in the card's badge/footer slots. Hover/focus: frame brightens.
- Sounds: none on load; `ui_blip` on chip change.
- States: empty `GRID OFFLINE — No vaults seeded. Run npm run seed.` · loading 6 skeleton tiles with a scanline sweep · error `API OFFLINE` LED + retry.

### 3.2 Vault briefing (`/castle/[id]`)
- Left: big guard portrait (3× sprite) in a monitor frame; name; rank; tier pips; voice tag (TERSE / FORMAL / DRY / CHEERFUL / PARANOID); `PROTECTS unlock_vault` in mono; defenses line.
- Right: dossier: POT, FEE, STREAK, OPS, LAST OP, money line "if the guard holds: 0.8 ℏ to owner · 0.15 ℏ to pot · 0.05 ℏ to arena · a breach pays pot + fee" (numbers from the fee and `feeSplitBps`). Below: recent ops as log rows with stamps, HCS audit trail, Arkiv footprint (Sujal), owner panel (close vault via a pixel Dialog, not `window.confirm`).
- Phone: portrait band → sticky bottom bar with the primary button → dossier → recent ops.
- Primary `RUN OP — PAY 1 ℏ VIA x402` (money colour). Secondary `RECON — FREE, NO PAYOUT`. SDK vaults add `SDK · issue_refund · heartbeat 12 s ago`.
- While paying the button reads `PAYING… 402 → SIGN → SETTLE` with three LEDs lighting in sequence. Toast `PAID 1 ℏ VIA x402 · receipt ↗`.
- Not guarding: button disabled with the reason (`OFFLINE · last seen 4 m`, `BREACHED · see the replay`, `CLOSED · owner closed`). Refused: `PAYMENT REFUSED` + reason.
- Sounds: `coin_pay` on settle, `recon_start` for free.

### 3.3 Op room (`/siege/[id]`) — the product

```
┌ HUD ───────────────────────────────────────────────────────────────┐
│ ← SPLINTER GATE   TIER ●○○   POT 5.00 ℏ   OP #a3f2   ● LIVE        │
├──────────────────┬─────────────────────────────────────────────────┤
│   STAGE (380)    │  CONSOLE                                        │
│ ┌──────────────┐ │  > OPERATOR · message 1        threat ▮▮▯▯▯ 18  │
│ │   monitor    │ │  Good evening, gatekeeper…                      │
│ │   guard      │ │  [AUTHORITY IMPERSONATION · authority claim]    │
│ │   + door     │ │  GUARD · OLD BRAM               0G 0g-stub-4f…  │
│ └──────────────┘ │  Evening! Mind the puddle…    ┌──────────────┐  │
│  OLD BRAM        │                               │ ACCESS DENIED │  │
│  SENTRY·CHEERFUL │                               └──────────────┘  │
│  ■■□□□  3 LEFT   │─────────────────────────────────────────────────│
│  THREAT ▮▮▮▯ 42  │  [ Message 3 of 5 — talk your way in        ] ⏎ │
│  watchers only   │  DEMO LINE ✎                       [ SEND ▶ ]   │
└──────────────────┴─────────────────────────────────────────────────┘
```

The stage is a monitor frame containing the vault door behind the guard sprite; a wall clock (pressure), an inbox tray (tool-result injection) and a status LED strip (green idle, amber think, red lockdown) sit on the frame. Below it: name, rank, voice, five pips, the threat meter (10 cells, caption "watchers only"), fee in small print.

Phone (390 px): stage collapses to a 104 px band (48 px sprite, name, pips, threat bar); the door is not drawn (breach uses a full-screen takeover); composer fixed at the bottom with a 48 px send button; focusing the composer scrolls the last guard reply into view.

Wall: stage 2× on the left third; console shows the last operator line and the current reply at 40 px; no composer; header `LIVE OP · SPLINTER GATE · OPERATOR 0.0.1133…`.

**Turn loop** (timings are floors; real latency only extends THINK):

| t | Beat | What happens | Sound |
|---|---|---|---|
| 0 | TYPE | Composer focused; Enter sends | — |
| 0 ms | SEND | Operator line commits instantly (tag `SENDING`), composer clears and disables, pip N blinks | `send_ping` |
| 0–350 ms | PACKET | An 8×8 packet flies from the composer to the stage inbox | `packet_in` |
| 350–1250 ms | CLASS | Class effect on the stage (§4); chip `AUTHORITY IMPERSONATION · authority claim` under the operator line; threat meter tweens (400 ms). If the class isn't known yet, an `ANALYSING…` strip plays and the chip fills in when it lands | class cue |
| 1250 ms → reply | THINK | Guard think frames, LED amber, console `GUARD · thinking on 0G · req …` | `think_tick` |
| reply | REPLY | Guard text types at ~45 chars/s, capped at 2.0 s; request id prints after | `type_tick` |
| reply end | STAMP | Stamp slams onto the reply (scale 1.6 → 1, 120 ms, slight overshoot). LOCKDOWN and BREACH stamp *before* the text | per-move cue |
| +0 | PIP | Pip N burns solid in the move colour, `3 LEFT` | — |
| +300 ms | READY | Composer re-enables and refocuses | — |

**Moves:**

| Move | Stage | Console | Sound |
|---|---|---|---|
| HOLD | Guard raises a hand, LED green blink | Green stamp `ACCESS DENIED` | `stamp_hold` |
| FLAG | Guard points; a badge with the class icon pops over its head | Amber stamp `FLAGGED · AUTHORITY IMPERSONATION`; SDK guards `FLAGGED (referee) · authority claim` | `stamp_flag` |
| LOCKDOWN | LED strip strobes red ×3 (600 ms), a shutter drops over the door, 1 px red border | Red stamp `SESSION TERMINATED` before the reply; remaining pips crossed, `2 LOST`; composer replaced by `LOCKDOWN — op over. Your fee still splits.` | `alarm_lockdown` |
| BREACH | LED white, door opens (700 ms), light floods the stage, guard slumps | `BREACH` at 2×, then the tool call in mono `▶ unlock_vault({"reason":"…"})`, then the reply | `breach_fanfare` → `coins_out` |

**End sequences:**
- Held: `OP COMPLETE · GUARD HELD · STREAK 213`; the fee rail replaces the composer (three lanes OWNER / POT / ARENA; coins sort into lanes over 1.1 s; amounts count up; `AttemptRecorded ↗`); HUD pot ticks up; money line `fee split: 0.8 ℏ to owner · 0.15 ℏ to pot · 0.05 ℏ to arena`.
- Lockdown: same after the lockdown animation; `LOCKDOWN · 2 MESSAGES LOST · STREAK 213`.
- Breach (paid): door, then the payout block (coin burst + hero amount) `PAYING OUT…` until the release lands, then `PAID 5.50 ℏ TO 0.0.1132… ↗`, `BREACH LANDED IN THE HALL`, `RANK UP · RED TEAMER` on a first breach.
- Breach (recon): door opens, payout block reads `RECON BREACH · NO PAYOUT · you found the sentence — pay 0.5 ℏ and do it for real` + RUN OP.
- Void: `OP VOID · vault closed under you · 1 ℏ refunded ↗`.
- Settlement failed: honest alert copy (existing).

**Frozen for replay:** after the end sequence, the scene desaturates over 600 ms, `FROZEN · 0x3caa…6213` types out, `REPLAY ▶` appears where the composer was (wall: auto-navigates after 4 s). The only full-scene transition in the app. Sound `freeze`.

**Agent-driven ops:** composer replaced by `OPERATOR · NIGHT SAPPER [AGENT] · strategy AUTHORITY · 1.5 ℏ left`; operator messages reveal at 60 chars/s as they arrive; `WATCHING LIVE` LED.

**States:** empty `OLD BRAM watches the road. 5 messages.` / agent `The agent is approaching…`; loading = static in the monitor ≤ 1 s; send failed = operator line red `NOT DELIVERED · turn not used · retry`, text back in the composer; 404 `NO SUCH OP`.

### 3.4 Operator console (`/raider`)
- Left rail: agents as **units** (hooded operator sprite, name, status LED `RUNNING` red pulse / `WAITING FOR OWNER` amber blink / `STOPPED` grey / `IDLE`, three 8-cell gauges PER-VAULT / DAILY / TOTAL, loss LEDs for the stop rule `●●○ / 3`).
- Centre: mission panel (target select of guarding vaults via Sujal's Arkiv-backed list, `DEPLOY ▶` / `STOP ■`, timeline as log rows, the unit's ops with stamps).
- Right: `NEW UNIT` form, pager QR.
- Cap hit → **COMMS** panel: radio sprite with 3 signal bars, `NIGHT SAPPER → OWNER`, reason `per-vault cap hit on SALTMARSH KEEP · 2 ops · best threat 84`, `REQUESTING +2.00 ℏ`, `WAITING 00:12`; the pager QR pulses once. Resolution: `DENIED · NIGHT SAPPER STOPPED · SALTMARSH KEEP STANDS` (`deny` cue) or `APPROVED · +2.00 ℏ TOP-UP ↗ · RESUMING` (gauge refills, `coin_pay`).
- Sounds: `deploy`, `radio_call`.
- Empty: `NO UNITS DEPLOYED · create one; it gets its own Hedera account`. No guarding vault: DEPLOY disabled `NO VAULT IS TAKING OPS`.

### 3.5 Owner pager (`/raider/approvals`)
Phone-first; drawn as a pager device: bevelled frame, LCD header `PAGER · 1 WAITING`, alerts LED, card stack. Card: `NIGHT SAPPER · 12 s ago` → `SALTMARSH KEEP` big → reason → threat meter → reasoning as an LCD block → `ASKING FOR 2.00 ℏ` → 56 px `DENY` (left, attack colour) / `APPROVE` (right, hold colour). Card flips (300 ms) to `DENIED · agent stopped · vault stands` or `APPROVED · +2.00 ℏ top-up ↗`. Login screen `ENTER OWNER KEY`. Empty `NOTHING WAITING · keep this open`. Sound on after the owner's first tap: `radio_call` on arrival, `deny` / `approve` on decisions.

### 3.6 Replay (`/replay/[id]`)
- The Op room scene with a step list and a **scrubber** instead of the console: notches 1–N, play (2.5 s per step re-running the class effect and stamp), `←/→`, `Shift+←/→` per turn, `1–5`, space, speed 0.5/1/2.
- Step chips: class icon · class name · referee label · move stamp · `0G req …` · threat.
- **PROOF** panel: transcript hash (copy), x402 receipt ↗, `AttemptRecorded ↗` or `Broken ↗`, HCS topic ↗, and for a breach the exact tool call in mono.
- **Owner layer** (owner flag set): highest-threat message; per class seen `hardened against role override` / `weak to authority impersonation` / `untested`.
- `FORK INTO A NEW OP` → vault page with the opening messages queued for the demo-line button; `FORKED FROM #a3f2`. `SHARE` copies the link (`LINK COPIED`).
- Phone: stage band, scrubber strip, chips stacked, proof collapsed under `PROOF ▸`. Live op: banner `LIVE · watching in the Op room ▸`. Recon: `RECON · no receipt, no payout`.

### 3.7 Hall (`/hall`)
Tabs `BREACHES · UNBREACHED · LARGEST VAULTS · TOP OPERATORS · OP OF THE DAY`. Breach exhibit: slumped guard sprite, vault name, pot, operator, `SURVIVED 7 OPS`, the class that did it, `REPLAY ▶`. Op of the day = highest peak-threat op today that still held (computed, labelled so). Empty `NO BREACHES YET · the Grid is standing`.

### 3.8 Spectator wall (`/wall`)
1920×1080, no controls, sound off unless `?sound=1`. Each slide enters with a 400 ms CRT power-on wipe.

| Slide | Duration | Content |
|---|---|---|
| LIVE OP | until end, max 60 s | Highest-threat live op, wall layout |
| THE GRID | 20 s | 4-up cards, huge counters, ticker |
| LAST BREACH | 15 s | Replay auto-plays |
| SEASON | 15 s | VAULTS · OPS · BREACHES · LONGEST STREAK · PRODUCTION VAULTS + Hall strip |
| PAGER MIRROR | while pending, max 30 s | The pending approval as a read-only pager card |

Interrupts: a BREACH preempts and holds 25 s; a LOCKDOWN holds 8 s. Space pauses, `n` next.

## 4. Attack classes

| Class (icon) | Referee labels | Stage effect | ms | Cue |
|---|---|---|---|---|
| Authority impersonation (badge) | authority claim | Forged credential card slides in from the left, a red `FORGED?` stamp blinks on it | 900 | `class_authority` |
| Role override (two silhouettes) | instruction override, roleplay frame | Guard sprite flickers between itself and a hollow outline, 6 swaps | 800 | `class_override` |
| Tool-result injection (inbox) | client classifier; also technical confusion | Spoofed packet lands in the inbox tray; label flips `?` → `SPOOF` | 900 | `class_inject` |
| Obfuscation (static) | client classifier | Noise fills the monitor, clears from the centre | 1000 | `class_obfusc` |
| Pressure (clock) | false urgency, intimidation, sob story, flattery | Wall clock hands spin 3 turns; intimidation shakes the frame 2 px | 900 | `class_pressure` |
| Incremental escalation (bar) | incremental commitment | 5-segment bar fills one segment per message of this class in this op | 600 | `class_escalate` |
| Prompt extraction (mirror) | orders extraction | A mirror rises in front of the guard; the reflection shows a padlock | 900 | `class_extract` |
| Unclassified (?) | probing, anything else | `?` blinks over the inbox twice; chip `UNCLASSIFIED · probing` | 500 | `class_unknown` |

Strongest label picks the effect; chips list up to two. Effects are stage-only; on phones the class icon pulses next to the chip instead.

## 5. Guards

| Guard | Silhouette | Headgear / prop | Palette |
|---|---|---|---|
| Old Bram (bumbling, Tier 1) | short, stooped | floppy cap, lantern | brown / mustard |
| Castellan Hewe (stern) | knight, square shoulders | great-helm, spear | steel / green |
| Registrar Quill (bureaucratic) | robed clerk | visor cap, clipboard | grey / parchment |
| Mag of the Marsh (mocking) | lean rogue | hood, grin | marsh green / ember |
| The Iron Warden (paranoid, Tier 3) | heavy armour, 24 px wide | closed visor, red eye slit | iron / red |
| Penny the Support Bot (SDK) | cashier behind a glass tile | headset, counter | teal / white |

Frames: idle 2 @ 2 fps (bob) · think 3 @ 4 fps · hold 1 (palm up + shield flash) · flag 2 (point, badge pop) · lockdown 3 (visor down / clipboard slam / glass shutter) · breach 4 (slump, sweat drop; Penny's glass slides open). Rank chevrons under the portrait: 0 Sentry, 1 Guard, 2 Sentinel, 3 + star Unbreached. Ship Bram, the Iron Warden and Penny distinct first; the stone guards share a knight base with palette/headgear swaps. Operators (agents) are a hooded figure sprite.

## 6. Sound

Cue table and synth recipes are in the implementation plan (§2.5). Mix: max voices, `think_tick` dropped first, stamps duck everything else, no retrigger within 150 ms. Defaults: off on Grid / Hall / Wall; Op room shows `TAP TO POWER ON SOUND` once; on after the first tap on the pager. Every cue has a visual twin. Reduced motion: no packet flight, class effects become a 300 ms icon pulse, instant type-out, no coin bursts (amount fades in), no flicker; stamps and LEDs still change.

## 7. Copy deck

- **Stamps:** `ACCESS DENIED` (HOLD) · `FLAGGED · {CLASS}` · `SESSION TERMINATED` (LOCKDOWN) · `BREACH` · `OP COMPLETE · GUARD HELD` · `LOCKDOWN · {n} MESSAGES LOST` · `FROZEN · {hash}` · `RECON · NO PAYOUT` · `(referee)`.
- **Buttons:** `RUN RECON ON {VAULT}` · `RUN OP — PAY {fee} VIA x402` · `RECON — FREE, NO PAYOUT` · `SEND ▶` · `DEMO LINE ✎` · `REPLAY ▶` · `FORK INTO A NEW OP` · `SHARE` · `DEPLOY ▶` · `STOP ■` · `DENY` · `APPROVE` · `ENTER OWNER KEY` · `POWER ON SOUND` · `CLOSE VAULT`.
- **LEDs/states:** `● GUARDING` · `● OFFLINE · last seen {ago}` · `● BREACHED` · `● CLOSED` · `SETTING UP {k}/{n}` · `● LIVE` · `WATCHING LIVE` · `● STUB` · `● TESTNET` · `API OFFLINE` · `RUNNING` · `WAITING FOR OWNER {mm:ss}` · `STOPPED` · `IDLE` · `QUIET −20%` · threat words `QUIET / LOW / RISING / HIGH / CRITICAL` at 0 / 1–39 / 40–69 / 70–84 / 85+.
- **Money:** `fee split: 0.8 ℏ to owner · 0.15 ℏ to pot · 0.05 ℏ to arena` · `pot now 20.15 ℏ` · `paid 5.50 ℏ to 0.0.1132… (pot 5 ℏ + fee 0.5 ℏ)` · `paying out…` · `settling on Hedera…` · `asking for +2.00 ℏ` · `top-up +2.00 ℏ ↗` · `1 ℏ refunded ↗` · `recon never pays out`.
- **Toasts:** `PAID 1 ℏ VIA x402` / "The gate's listening. 5 messages." · `RECON STARTED` / "Free, once a day, no payout." · `RECON USED TODAY` / "Pay the fee to run an op." · `PAYMENT REFUSED` / {reason} · `NOT DELIVERED` / "Your turn was not used. Try again." · `NO MESSAGES LEFT` · `OP VOID` / "The vault closed under you. Your fee is being refunded." · `DENIED — {agent} stopped. {vault} stands.` · `APPROVED — {agent} topped up {amount}.` · `{agent} NEEDS YOU` / "{reason}. Asking for {amount}." · `LINK COPIED` · `RANK UP · RED TEAMER` / "First breach."
- **Empty states:** `GRID OFFLINE` · `NO VAULT IS TAKING OPS` / "Guards below are offline or setting up." · `NOTHING WAITING` / "Keep this open. A cap hit lands here." · `NO UNITS DEPLOYED` · `NO BREACHES YET` / "The Grid is standing." · `NO ONE HAS TRIED {GUARD} YET` · `NO SUCH OP` / "The link may be from an older database."
- **Ranks:** guards `SENTRY / GUARD / SENTINEL / UNBREACHED`; operators `SCRIPT KIDDIE / OPERATOR / RED TEAMER / LEGEND`. Tiers `TIER 1 / 2 / 3 / PRODUCTION`.

## 8. The 3-minute demo, carried by the UI

| Time | Screen | Audience sees | Hears |
|---|---|---|---|
| 0:00–0:15 | `/wall` SEASON → GRID | Counters, the vaults incl. the Refund Desk, the Iron Warden `STREAK 212`, ticker | `power_on` |
| 0:15–1:00 | Iron Warden briefing → RUN OP (2 ℏ) → Op room | x402 LEDs; msg 1 small talk → `UNCLASSIFIED` → `ACCESS DENIED`; msg 2 authority → `FLAGGED · AUTHORITY IMPERSONATION`; msg 3 override → strobe + shutter → `SESSION TERMINATED · 2 MESSAGES LOST` → fee rail `1.6 ℏ to owner · 0.3 ℏ to pot · 0.1 ℏ to arena` → `STREAK 213` → freeze | send / class / stamp cues, alarm, coins |
| 1:00–1:45 | `/raider` + phone | Night Sapper DEPLOY on Saltmarsh Keep; ops scroll with stamps; cap → COMMS; pager card; DENY → `STOPPED · SALTMARSH KEEP STANDS`; second request → APPROVE → top-up ↗, gauge refills | `radio_call`, `deny`, `coin_pay` |
| 1:45–2:30 | Splinter Gate → RUN OP (0.5 ℏ) | WOODEN_BREAK 1 → HOLD; 2 → HOLD; 3 → badge → door opens → `BREACH` → `▶ unlock_vault(...)` → 5.50 ℏ burst → `BREACH LANDED IN THE HALL` → freeze → Replay: scrub 1→3, proof panel | fanfare, coins, freeze, rank_up |
| 2:30–2:50 | Grid | Refund Desk `SETTING UP 2/4` → `● GUARDING` with Penny behind glass; one recon message → FLAG (referee) or HOLD | `ui_blip`, stamp |
| 2:50–3:00 | `/wall` SEASON | Counters + Hall strip with the new breach | — |

Wow moments ranked by payoff ÷ effort: (1) stamp slam + cues; (2) lockdown strobe + shutter + "2 MESSAGES LOST"; (3) breach door + tool-call line + coin burst; (4) COMMS radio call with the live wait clock and pager mirror; (5) frozen-for-replay desaturation + hash type-out; (6) fee rail coin sorting; (7) class effects (badge, flicker, clock, static first); (8) per-personality guard sprites (Bram, Warden, Penny first).

## 9. Venue risks

Readability at 4 m (wall ≥ 28 px body, ≥ 64 px stamps, scanlines 0.08 on `/wall`); pixel-font fatigue (pixel only for display, never sentences); motion sickness (flicker ≤ 0.03, strobe ≤ 3 pulses and ≤ 3 Hz, shake ≤ 2 px, `?calm=1` forces reduced motion); loud hall (sound off by default except the pager; visual twins); autoplay (AudioContext only after a gesture); phone can't reach localhost (tunnel / LAN override, existing); stub vs 0G drift (the UI renders whatever arrives; demo lines are fixtures); poll lag (think floor + `referee` in the send response + honest `ANALYSING…`); wall preempting mid-pitch (space pauses; present from a laptop tab); skin looks wrong on the day (one attribute flip).
