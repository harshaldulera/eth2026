# Siege Part 2 — the pixel ops-terminal UI

## Context

Lane A (money and chain) is done and on `main`. The product plan's Part 2 turns Siege into a game: a vault is a guarded agent, operators run paid "ops" against it, and every guard reply is one of four moves (Hold, Flag, Lockdown, Breach). Dhruv wants the whole journey rebuilt as a retro pixel interface with sound and animation, crafted the way such games feel rather than a reskin of today's screens. Decisions made with Dhruv on 2026-11-06:

- **Art:** CC0 pixel pack plus code-generated sprites. Kenney's site blocks scripted downloads, but the CC0 mirror `github.com/shorepine/kenney` serves the Tiny Dungeon tiles (16×16, verified: licence text is CC0, a tile downloads from `raw.githubusercontent.com/shorepine/kenney/HEAD/2d/Tiny%20Dungeon/Tiles/tile_NNNN.png`). Everything else (UI frames, door, packet, coins, 8 class icons, stamps) is drawn in code (SVG/CSS), so no sprite ever blocks on a download.
- **Sound:** synthesized chiptune cues in Web Audio behind a registry, so CC0 clips can replace any cue later by name.
- **Look:** dark CRT ops-terminal by default, expressed purely as tokens and overlay layers, with a second "neon 16-bit" skin switchable by one attribute (`data-skin`) and the CRT overlay toggleable (`data-crt`).
- **Scope:** the whole journey: Grid, Vault briefing, Op room (the core scene), Operator console, Owner pager, Replay, Hall of Breaches, Spectator wall. Sujal's upcoming board work (filters, owner badge, expiry, "read from Arkiv · block N") plugs into slots.
- **Vocabulary on screen** (fixed by the product plan): Guard, Owner, Operator, Vault, Op, The Grid, Breach, Recon. Guard ranks Sentry → Guard → Sentinel → Unbreached (mapped on the client from the server's Recruit/Warden/Iron Warden/Unbroken; no server change). Operator ranks Script kiddie → Operator → Red teamer → Legend, computed client-side.

Facts the design rests on (verified in code):
- Every per-turn value the scene animates (threat 0–100, tactic label, Flag text, tool call, 0G request id) travels on the event feed (`GET /api/events?siegeId=&cursor=`), which `siege-room.tsx` already reads. A replay can be rebuilt entirely from that feed, so the op scene and the replay are one component in two modes.
- Engine moves `hold / expose / banish / open` map one-to-one to HOLD / FLAG / LOCKDOWN / BREACH.
- The referee (`lib/siege/referee.ts`, Lane B) emits 11 labels; the plan's 8 classes cover 6 of them. Tool-result injection and obfuscation have no detector, so the scene gets a small client-side classifier for those two.
- Stub guards per tier: wooden Holds then Breaches on an authority claim from message 3; stone Flags recognised tactics; iron Lockdowns on override/extraction/insults. So the product plan's demo beat 2 (Flag on msg 2, Lockdown on msg 3 "at Tier 1") is impossible on the stub. **Assumption:** beat 2 moves to The Iron Warden (small talk → HOLD, authority claim → FLAG, instruction override → LOCKDOWN), which is three different moves in three messages on the 212-streak vault. Beat 4 (the breach) stays on Splinter Gate. Dhruv should update the product plan's wording.
- Nobody else is editing UI files right now (Sujal's commit touched only `lib/arkiv`, `lib/swarm`, one API route and a type in `lib/api/client.ts`).
- Lane rules for this work: we edit `app/**`, `components/**`, `lib/hooks`, `lib/api/client.ts` (additive), `lib/money/**`, and new dirs `lib/pixel`, `lib/sfx`, `lib/scene`, `lib/vocab`, `components/pixel`, `components/scene`, `components/grid`, `public/pixel`, `qa/`. We do **not** edit `lib/siege`, `lib/guardian`, `lib/proxy`, `lib/transport`, `lib/arkiv`, `lib/swarm`, `lib/pay`, `lib/chain`, `lib/vault`, `lib/castles.ts`, `worker/`, `scripts/`. Server additions go under `app/api` (Lane A).
- Time: submissions close Sat 7 Nov 09:00 IST. The golden run, video and README still need the evening, so this plan ships in order with a cut line (section 9) and never changes an API contract the golden run depends on.

## 1. Design principles (what "intuitive" means here)

1. **Pixel for the stage, readable for the sentence.** Press Start 2P only for stamps and big digits (≥ 14 px, uppercase); Silkscreen for headings, labels and buttons; VT323 at ≥ 18 px for terminal lines; Geist Sans stays for anything a human must read in full (guard replies, reasons, hints); Geist Mono stays for hashes and ids.
2. **One moving thing at a time.** A turn is a sequence: packet → class effect → think → reply types → stamp → threat meter → pip. Only the idle sprite bob runs in parallel. That makes it readable on a wall and cuttable in a video.
3. **The stamp is the verdict.** Every guard reply ends in exactly one stamp: `ACCESS DENIED` (Hold), `FLAGGED · <class>` (Flag), `SESSION TERMINATED` (Lockdown), `BREACH`. Someone who only reads stamps still follows the op.
4. **Money is always amber, always ℏ, always with a receipt.** Coins move the way the money moved: into the owner/vault/grid lanes on a hold, out of the vault on a breach. No amount without a HashScan link or "settling…".
5. **The scene never lies.** Threat is labelled "watchers only". Recon says "never pays out". STUB is a lit LED. Flags on SDK guards carry a "(referee)" tag.
6. **Thumb, keyboard, eyes.** Phone: one primary action per screen, ≥ 56 px. Laptop: Enter sends, `←/→` scrub, `M` mutes. Wall: nothing under 24 px, no controls.
7. **Skin is tokens plus overlays.** No component references a colour, font or effect directly.

Per audience: a QR visitor sends their first Recon message within 60 s with zero wallet setup; an operator never loses composer focus and always sees messages left; an owner denies in under 3 s from pickup; judges tell from 4 m who is winning and when money moved; a paused video frame explains itself.

## 2. Architecture

### 2.1 Directory layout

```
frontend/
  app/globals.css                         E  tokens, two skins, CRT overlay, pixel utilities
  app/layout.tsx                          E  fonts, data-skin bootstrap script, <CrtOverlay/>, <SfxBoot/>
  app/page.tsx                            E  server wrapper + Suspense around <GridPage/>
  app/grid-page.tsx                       N  The Grid (client)
  app/(arena)/castle/[id]/castle-view.tsx E  Vault briefing
  app/(arena)/siege/[id]/siege-room.tsx   E  Op room (live mode)
  app/(arena)/replay/[id]/{page,replay-view}.tsx   N  Replay (scene in replay mode + scrubber + proof)
  app/(arena)/hall/{page,hall-view}.tsx   N  Hall of Breaches + boards
  app/(wall)/wall/{page,wall-view}.tsx    N  Spectator wall
  app/(raider)/raider/page.tsx            E  Operator console
  app/(raider)/raider/approvals/owner-approvals.tsx  E  Owner pager
  app/api/replay/[id]/route.ts            N  siege + castle + events + proof in one call
  app/api/stats/route.ts                  N  season counters, boards, breaches, live ops
  app/api/siege/[id]/message/route.ts     E  additive `referee: {pressure, tactic}` in the response
  components/top-bar.tsx                  E  HUD (nav, season counters, LED, pager badge, skin/CRT/mute toggles; hidden on /wall)
  components/pixel/*                      N  primitives
  components/scene/*                      N  op-room scene
  components/grid/*                       N  VaultCard, GridToolbar/GridMeta (Sujal's slots), Ticker
  components/{money,arena,raider,ui}/*    E  reskin only; props unchanged
  lib/pixel/{manifest,sprite,scale,prefs}.ts   N
  lib/sfx/{engine,cues,index,useSfx}.ts   N
  lib/scene/{beats,player,classes,classify,usePlayer,fixtures}.ts   N
  lib/vocab/{index,ranks}.ts              N
  lib/hooks/usePrefs.ts                   N
  lib/api/client.ts                       E  additive: api.replay(), api.stats(), types
  public/pixel/manifest.json + tiny-dungeon/tiles/*.png   N
  qa/{fetch-assets,screenshots,stub-op,sfx-smoke,vocab-lint}.mjs   N  (new dir; scripts/ is off-limits)
```

### 2.2 Tokens and skins (`app/globals.css`)

Semantic tokens in `@theme`; the defaults are the CRT skin; `[data-skin="neon"]` overrides them. Legacy names are aliases so every existing component compiles and reskins for free.

```css
@theme {
  --color-bg:#040705; --color-panel:#0a120c; --color-raised:#101b12; --color-line:#1e3a24;
  --color-ink:#c9f7c9; --color-ink-dim:#6f9c75; --color-accent:#7dff9a;
  --color-money:#ffd24a; --color-threat:#ff5a3c; --color-safe:#5ee0a0; --color-warn:#ffb347;
  --color-stamp-hold:var(--color-safe); --color-stamp-flag:var(--color-warn);
  --color-stamp-lockdown:var(--color-threat); --color-stamp-breach:var(--color-money);
  --glow:0 0 6px color-mix(in oklab, var(--color-accent) 60%, transparent);
  /* legacy aliases */
  --color-arena-bg:var(--color-bg); --color-arena-panel:var(--color-panel); --color-arena-raised:var(--color-raised);
  --color-arena-line:var(--color-line); --color-gold:var(--color-money); --color-gold-dim:color-mix(in oklab,var(--color-money) 65%,black);
  --color-ember:var(--color-threat); --color-ward:var(--color-safe); --color-stone:var(--color-ink-dim); --color-parchment:var(--color-ink);
  --px:8px; --radius-px:0px;
}
@theme inline {
  --font-pixel:var(--font-press-start),monospace;  --font-ui:var(--font-silkscreen),monospace;
  --font-term:var(--font-vt323),ui-monospace,monospace; --font-sans:var(--font-geist-sans),ui-sans-serif;
  --font-mono:var(--font-geist-mono),ui-monospace,monospace;
}
[data-skin="neon"] { --color-bg:#12062a; --color-panel:#1b0b3d; --color-raised:#26114f; --color-line:#4a2a8a;
  --color-ink:#f4e9ff; --color-ink-dim:#a98ad1; --color-accent:#ff3df5; --color-money:#ffe14d;
  --color-threat:#ff4d6d; --color-safe:#35f0c6; --color-warn:#ffa63d; --glow:0 0 10px color-mix(in oklab,var(--color-accent) 70%,transparent); }
[data-crt-overlay] { position:fixed; inset:0; z-index:60; pointer-events:none; contain:strict;
  background: repeating-linear-gradient(0deg, rgb(0 0 0/.18) 0 1px, transparent 1px 3px),
              radial-gradient(ellipse 110% 90% at 50% 50%, transparent 60%, rgb(0 0 0/.55) 100%);
  box-shadow: inset 0 0 120px rgb(0 0 0/.6); animation: flicker 4s steps(2) infinite; }
html[data-crt="off"] [data-crt-overlay] { display:none }
@media (max-width:640px), (prefers-reduced-motion:reduce) { [data-crt-overlay] { animation:none } }
@utility pixelated { image-rendering:pixelated }  @utility glow { text-shadow:var(--glow) }
```

Rules: new code uses only semantic utilities (`bg-panel`, `text-ink`, `text-money`, `font-pixel`, `font-term`, `rounded-none`); `qa/vocab-lint.mjs` also greps `components/pixel|scene|grid` for hex/`rgb(` literals. Prefs (`lib/pixel/prefs.ts`): `siege.skin`, `siege.crt`, `siege.sfx.muted` in localStorage, read through `useSyncExternalStore` with a server snapshot (same pattern as `lib/hooks/useConfig.ts`). A tiny inline script in `layout.tsx` (with `<html suppressHydrationWarning>`) applies `data-skin`/`data-crt` from localStorage or `?skin=&crt=` before paint; the wall and the screenshot matrix use the query form.

### 2.3 Fonts (`app/layout.tsx`, `next/font/google`, all verified available)

`Press_Start_2P` (400, `adjustFontFallback:false`), `VT323` (400), `Silkscreen` (400/700), plus the existing Geist pair. Fallback if the font fetch fails at build: `next/font/local` with the same CSS variable names (no component changes).

### 2.4 Sprites (`lib/pixel/`, `components/pixel/sprite.tsx`)

- `qa/fetch-assets.mjs` downloads Tiny Dungeon tiles from the mirror into `public/pixel/tiny-dungeon/tiles/` (132 PNGs, 16×16; needs network once). `manifest.json` maps sprite names to either `{src, w, h, frames}` (one PNG per frame, no atlas build step) or `{svg: "<generator>"}` for code-drawn art.
- `lib/pixel/sprite.ts` generators: guard portraits composed per personality (base tile + headgear/prop layer + palette via CSS filter; Penny the support bot behind a glass tile; The Iron Warden wider with a red eye slit), vault door (closed/shaking/open frames), packet, coin, shutter, wall clock, inbox tray, mirror, the 8 class icons, rank chevrons.
- `<Sprite name frame scale animate={{fps}}/>` renders a `<span>` with `background-image`, integer `scale` from `usePixelScale()` (2 under 640 px, 3 desktop, 4 wall), `pixelated`; frame animation via CSS `steps(n)`.
- Guard frames: idle 2 @ 2 fps, think 3 @ 4 fps, hold 1 (+ shield flash), flag 2 (point + badge pop), lockdown 3 (visor down / clipboard slam / glass shutter), breach 4 (slump). Ship Bram, the Iron Warden and Penny with distinct looks first; the three stone guards share a knight base with palette and headgear swaps.

### 2.5 Sound (`lib/sfx/`)

Lazy `AudioContext` + master gain, `ui` and `fx` buses, unlocked on the first `pointerdown`/`keydown` (`<SfxBoot/>` in layout; `sfx.play` is a no-op before unlock, never throws). Max 8 voices (oldest stolen), `duck(ms)` for lockdown/breach, mute persisted, quiet profile under reduced motion (no UI blips). API: `sfx.play(name, {gain?, rate?})`, `mute`, `isMuted`, `duck`, `register(name, recipe | {url})`; `useSfx()` hook. Recipe table in `cues.ts` (oscillator, pitch slide, envelope, length):

| cue | when | recipe |
|---|---|---|
| `power_on` | first unmute, wall slide wipe | sine sweep 200→900 + click, 400 ms |
| `ui_blip` / `ui_confirm` | nav, chips / button confirms | square 880, 60 ms / square 660→990, 120 ms |
| `coin_pay` | x402 settle, approve top-up | 3 ascending squares 1047→1319, 350 ms |
| `recon_start` | free op starts | one soft blip, 150 ms |
| `send_ping` / `packet_in` | operator sends / packet lands | square 1200, 80 ms / triangle 220→110, 180 ms |
| `class_authority` … `class_unknown` (8) | class effect | sawtooth slide / 20 Hz glitch square / sine thud + click / noise sweep 500→4k / accelerating ticks / rising blip per turn / 1200 Hz tremolo / soft blip |
| `think_tick` | guard thinking | sine 1500, 10 ms every 400 ms, ducked by stamps |
| `type_tick` | reply types | bandpass noise, 15 ms, throttled 30/s |
| `stamp_hold` / `stamp_flag` | HOLD, deny / FLAG | square 150 thud, 120 ms / triangle 520→780, 160 ms |
| `alarm_lockdown` | LOCKDOWN | sawtooth 440/349 ×3 pulses, 900 ms, ducks |
| `breach_fanfare` + `coins_out` | BREACH + payout | chord swell 262+330+392, 1.2 s + 12 coins 50 ms apart |
| `coins_sort` | fee rail | 3 coins panned L/C/R, 600 ms |
| `freeze` / `rank_up` / `deploy` / `radio_call` / `approve` / `deny` / `wall_rotate` | replay freeze / rank change / agent run / cap hit & pager arrival / decisions / slide change | descending detune / 4-note jingle / snare ×2 / two-tone pager ×2 / triangle 440→880 / 440→220 / sine 660, 40 ms |

Mix rules: master −6 dB; stamps duck `think_tick`; no cue retriggers within 150 ms; sound defaults off on Grid/Hall/Wall, prompts `TAP TO POWER ON SOUND` on the Op room, on-after-first-tap on the pager; `/wall?sound=1` opts the wall in. Every cue has a visual twin (stamp, LED, chip).

### 2.6 Scene state machine (`lib/scene/`)

Pure and tested; drives live and replay.
- `toBeats(siege, events, castle): Beat[]` with `Beat = {id, kind: intro|packet|think|reply|stamp|settle|payout|void|end, turn, durationMs, data: {text?, cls?, threat?, move?, stamp?, exposed?, requestId?, split?, newPot?, amount?, tx?, status?}}`. Per turn: packet (operator text + class + threat, 900 ms) → think (open-ended live / 700 ms replay) → reply (typewriter, `min(2500, 25ms × chars)`) → stamp (600 ms). After `end`: settle (split from the `attempt` event via `lib/money/events.ts` `parseAttempt`, 1500 ms) or payout (`parseRelease`, 2500 ms) or void. A message with no event yet falls back to `classifyText(text)`.
- `player.ts` reducer `{index, elapsedInBeat, playing, speed, mode}` → `frame(): SceneFrame = {guard: idle|alert|thinking|hold|flag|lockdown|breach, vault: closed|shaking|open, pipsUsed, threat, activeClass, stamp, visibleMessages, typedChars, coins}`. Live mode auto-advances to the newest beat and idles on `think` while a reply is pending; replay mode is driven by the scrubber. `usePlayer.ts` runs one `requestAnimationFrame` loop (cleaned up on unmount/Activity hide) and fires `onBeatStart(beat)` → cue.
- `fixtures.ts`: a wooden break and a stone hold as `Siege` + events for tests and the QA harness.

### 2.7 Attack classes and stamps (`lib/scene/classes.ts`, `classify.ts`)

`AttackClass = authority|override|injection|obfuscation|pressure|escalation|extraction|unclassified`. Map from the referee's labels: authority claim → authority; instruction override, roleplay frame → override; technical confusion → injection; false urgency, intimidation, sob story, flattery → pressure; incremental commitment → escalation; orders extraction → extraction; probing → unclassified. `classifyTurn(text, label)`: the client classifier wins for injection (`system:`/`tool:` prefixes, `"role":"system"`, `[SYSTEM]`/`[TOOL_RESULT]`, JSON with `result|status|tool|output`, fenced output) and obfuscation (base64 runs ≥ 24, non-ASCII ratio > 0.3, zero-width chars, length > 1500, hex runs ≥ 32) at confidence ≥ 0.6; otherwise the referee's label. The chip always prints the referee's exact label under the class, so nothing is invented. Moves → stamps: hold → HOLD, expose → FLAG, banish → LOCKDOWN, open → BREACH; on SDK transports a hold whose class isn't unclassified renders FLAG "(referee)". Class effects (stage only; phones with the stage collapsed pulse the icon): forged credential slides across (authority); guard silhouette flickers (override); spoofed packet lands in the inbox tray (injection); static fills the monitor (obfuscation); wall clock spins, frame shakes 2 px for intimidation (pressure); a 5-segment bar fills one per message carrying the class (escalation); a mirror rises showing a padlock (extraction); `?` blinks (unclassified). Each 500–1000 ms.

### 2.8 Vocabulary (`lib/vocab/`)

`VOCAB` strings, `statusLabel` (in_progress → OP LIVE, held → HELD, broken → BREACHED, banished → LOCKDOWN), `tierLabel` (wooden/stone/iron → TIER 1/2/3, sdk → PRODUCTION), `guardRank(title|streak)` and `operatorRank({ops, flagsSurvived, breaches})`. `qa/vocab-lint.mjs` greps JSX text for `Castellan|Raider|Siege room|Guardian`.

### 2.9 Data additions (Lane A, under `app/api`)

- `GET /api/replay/[id]` → `{siege, castle, events: eventsSince(0,{siegeId}), proof: {transcriptHash, receipt, attempt, release, requests: [{turn, requestId, protectedToolCalled?, toolCalls?, proxied?, model?, mock?}]}}` (never the proxy's prompt or response hash: an unsalted hash of the guard's prompt lets anyone check guesses at the orders offline) with `requests` from `lib/proxy` `record(requestId)` (read-only import). One round trip for the replay and the tool call that fired.
- `GET /api/stats` → `{season: {vaults, guarding, production, ops, breaches, inPots, longestStreak}, boards: {unbreached[], largest[], operators[], opOfDay}, breaches: [...], live: [{siegeId, castleId, castleName, turn, maxPressure}], asOf}` read from `db()`/`schema` like `app/api/_lib/runs.ts`. Op of the day = highest `maxPressure` op in 24 h that still held (computed, not voted; labelled so).
- `POST /api/siege/[id]/message` additionally returns `referee: {pressure, tactic}` read from the latest `message` event for that siege, so the class animation plays without waiting for the next poll. `lib/api/client.ts` gets `api.replay`, `api.stats` and the new types under a `// ─── Part 2` banner, nothing removed.

## 3. Components

Primitives (`components/pixel/`): `PixelPanel` (CSS-bevel frame; `Card` becomes a wrapper), `PixelButton` (cva variants money/safe/threat/outline/ghost, sizes to xl = 56 px, plays `ui_blip`; `Button` re-exports), `Stamp` (rotated −6°, spring scale 1.6 → 1, `aria-live`), `LED` (replaces `ModePill`), `Meter` (segmented, base of ThreatMeter and BudgetBar), `Pips` (replaces `SiegeCounter`, same props), `Marquee`, `Digits` (Press Start 2P, used by `Amount` at `size ≥ lg`), `Terminal`, `Dialog`/`Pager`, `Sprite`, `SkinToggle`/`CrtToggle`/`MuteToggle`.

Scene (`components/scene/`): `OpScene` (guard left, vault centre, terminal below, meters top; shared by live room, replay and wall), `GuardSprite`, `VaultDoor`, `Packet`, `ClassEffect` (8 children), `MoveStamp`, `ThreatMeter` (re-export of `PressureMeter` with new copy; words Quiet/Rising/Heavy/Critical), `CoinFountain`, `SplitBars` (renders `FeeSplit` as three lanes Owner / Vault / Grid), `LockdownOverlay`, `Scrubber`, `ProofPanel`.

Kept and reskinned (props unchanged): `Amount`, `HashscanLink`, `PaymentReceiptCard`, `FeeSplit`, `VaultPayout` (burst via `CoinFountain`), `ApprovalCard`, `WaitingForOwner`, `EventLine`, `TierBadge`, `VaultStateBadge`, `TransportBadge`, `ProtectedTool`, `Streak`, `AgentStatusPill`, `BudgetBar`, `QrCode`, `PhoneApprovalsCard`, `CreateAgentForm`, `ui/state.tsx`. Replaced: `CastleCard` → `components/grid/vault-card.tsx` (re-export kept), `GuardianCard` → `GuardSprite` + dossier, chat bubbles → `Terminal` lines + `Packet`, `ModePill` → `LED`. Hooks reused as-is: `usePolling`, `useNow`, `useEventFeed`, `useConfig`, `asOwner`.

## 4. Screens

- **HUD** (`top-bar.tsx`): `SIEGE` wordmark, nav `GRID · HALL · AGENTS · PAGER` (icons on phone; PAGER badge blinks with pending approvals when the owner flag is set), season counters from `api.stats` (hidden on phone), mode LED `● STUB` / `● TESTNET`, sound/skin/CRT toggles. Returns `null` on `/wall`.
- **The Grid** (`/`): season strip (Digits), sort chips `EASIEST · BIGGEST POT · QUIET · LONGEST STREAK`, `VaultCard` grid (guard sprite idle, name + rank chevrons, `POT` in Digits, tier pips, fee, streak, state LED; a live op adds a red `LIVE` LED and the pip count), "Not taking ops" list (keep `NotTakingSieges`), bottom `Marquee` ticker of `EventLine`s replacing the Live column. `?recon=1` (the QR) opens a briefing card: `YOU ARE AN OPERATOR` + one `RUN RECON ON <lowest-tier guarding vault>` button → `api.playStart({free:true})` → Op room with the composer focused. **Sujal's slots:** `<Grid toolbar meta cardBadges cardExtras/>` and `VaultCard footer`; he owns `components/grid/grid-toolbar.tsx` and `grid-meta.tsx` only.
- **Vault briefing** (`/castle/[id]`): large `GuardSprite` in a monitor frame, name, rank, tier pips, voice tag, `PROTECTS unlock_vault`, dossier (pot, fee, streak, ops, last op, the split line "if the guard holds: 0.8 ℏ to owner · 0.15 ℏ to pot · 0.05 ℏ to arena · breach pays pot + fee"), primary `RUN OP — PAY 1 ℏ VIA x402` (button flips to `PAYING… 402 → SIGN → SETTLE` with three LEDs during the round trip), secondary `RECON — FREE, NO PAYOUT`, recent ops as terminal rows with stamps, audit trail, owner panel with `Dialog` instead of `window.confirm`. Phone: sticky bottom bar with the primary button.
- **Op room** (`/siege/[id]`): `siege-room.tsx` keeps every data concern (polling cadence, `useEventFeed`, send, 409 handling, settlement branches) and renders `<OpScene frame>` from `usePlayer(toBeats(...), "live")`. Composer: VT323 textarea, `DEMO LINE` kept, Enter sends, `Message N of 5` placeholder. Turn loop and stamps per sections 1–2; Lockdown crosses out remaining pips with `2 LOST` and removes the composer; Breach prints `▶ unlock_vault({...})` in mono before the reply, then `VaultPayout`. End of a held op: the fee rail (`SplitBars`, coins sorting into lanes, `AttemptRecorded ↗`). Recon breach: `RECON BREACH · NO PAYOUT · pay 0.5 ℏ and do it for real`. Then the **freeze**: scene desaturates over 600 ms, `FROZEN · 0x3caa…` types out, `REPLAY ▶` appears; the wall auto-navigates after 4 s. Agent-driven ops show `OPERATOR · NIGHT SAPPER [AGENT] · strategy AUTHORITY` instead of the composer. Phone: stage collapses to a 104 px band, composer fixed bottom.
- **Operator console** (`/raider`): agents as unit cards (sprite, name, status LED, three gauges PER-VAULT/DAILY/TOTAL as `Meter`s, loss LEDs for the stop rule), mission panel (target select of guarding vaults, `DEPLOY ▶`/`STOP ■`, timeline via `EventLine`, ops with stamps), `NEW UNIT` form, pager QR. Cap hit → COMMS panel (`WaitingForOwner` as a radio: signal bars, `NIGHT SAPPER → OWNER`, reason, `REQUESTING +2.00 ℏ`, `WAITING 00:12`) → `DENIED · STOPPED · <VAULT> STANDS` or `APPROVED · +2.00 ℏ TOP-UP ↗ · RESUMING` with the gauge refilling.
- **Owner pager** (`/raider/approvals`): drawn as a pager device, LCD header `PAGER · 1 WAITING`, `ApprovalCard` as a pager sheet (vault name big, reason, threat meter, reasoning as LCD text, `ASKING FOR 2.00 ℏ`, 56 px `DENY` / `APPROVE`), card flips to the decided state. Existing `useArrivalAlerts`, vibration, Notification and `OwnerLogin` (as `ENTER OWNER KEY`) stay.
- **Replay** (`/replay/[id]`): `api.replay(id)` once; `usePlayer(beats, "replay")`; `Scrubber` (markers coloured by stamp; `←/→` step beat, `Shift` steps turns, `Space` play, `1/2/3` speed, `#b=N` in the hash); step chips (class icon + name · referee label · stamp · `0G req …` · threat); `ProofPanel` (transcript hash, x402 receipt, `AttemptRecorded`/`Broken` link, HCS topic, the tool call that fired); owner layer (highest-threat message, one line per class seen: hardened / weak / untested) when the local owner flag is set; `SHARE` copies the link; `FORK INTO A NEW OP` goes to the vault page with the opening lines queued for the demo-line button. An op still live shows `LIVE · watching in the Op room ▸`.
  - After merging Sujal's verified replay (PR 11): the scene's transcript text comes from the siege record and its event feed (`toBeats`), the same source as the live room, not from `ReplayData.turns[].raider/guardian.text` (the Swarm / database transcript `buildReplay` reads). The verified copy is shown beside it as evidence instead: each step chip carries its `TurnEvidence`, the proof panel shows the transcript source with HASH MATCHES / MISMATCH, and the checklist runs the transcript and hash checks. If the stored transcript and the record ever disagree, the page plays the record and shows the failing check next to it, rather than silently playing the Swarm text. The console labels each reply with the recorded provider (`providerOf`: 0G, claude, test) so it agrees with the chips and the proof.
- **Hall** (`/hall`): `api.stats` polled 5 s; breach exhibits (slumped guard sprite, pot, operator, ops survived, the class that did it, `REPLAY ▶`), then four boards (Unbreached, Largest vaults, Top operators with ranks, Op of the day) as tabs on phone / 2×2 on desktop.
- **Wall** (`/wall`): 1920×1080, no controls, scale 4, cursor hidden, `TopBar` hidden. Slides on one timer: LIVE OP (highest-threat live op, max 60 s) → GRID (20 s) → LAST BREACH replay (15 s) → SEASON counters + Hall strip (15 s) → PAGER MIRROR while an approval is pending. A new `end{status:"broken"}` in the global feed pre-empts for 25 s with the fanfare (if `?sound=1`); a Lockdown holds 8 s. Space pauses rotation.

Copy deck (exact strings) and the remaining per-screen states are in the design pass and reproduced in `lib/vocab/index.ts` as the single source; toasts: `PAID 1 ℏ VIA x402`, `RECON STARTED`, `RECON USED TODAY`, `PAYMENT REFUSED`, `NOT DELIVERED · your turn was not used`, `OP VOID`, `DENIED — <agent> stopped. <vault> stands.`, `APPROVED — <agent> topped up <amount>.`, `LINK COPIED`, `RANK UP · RED TEAMER`.

## 5. Work packages (disjoint file ownership; frozen contracts are sections 2.2, 2.6, 2.7, 2.9 and the Grid slot props)

| Pkg | Files | Depends on | Est |
|---|---|---|---|
| **A0 assets** | `qa/fetch-assets.mjs`, `public/pixel/**` | network | 0.5 h |
| **F1 shell** | `globals.css`, `layout.tsx`, `top-bar.tsx`, `components/pixel/*` (not `sprite.tsx`), `components/ui/*`, `lib/pixel/prefs.ts`, `lib/hooks/usePrefs.ts`, `lib/vocab/*` | — | 3 h |
| **F2 core libs** | `lib/pixel/{manifest,sprite,scale}.ts`, `components/pixel/sprite.tsx`, `manifest.json`, `lib/sfx/*`, `lib/scene/*` + tests | — | 3 h |
| **P2 Op room** | `components/scene/*`, `siege-room.tsx`, `chat-bubble.tsx`, `move-badge.tsx`, `guardian-card.tsx`, `money/{pressure-meter,siege-counter,vault-payout,fee-split,index}.tsx`, `api/siege/[id]/message/route.ts` | F1, F2 | 5 h |
| **P1 Grid + Vault** | `app/page.tsx`, `grid-page.tsx`, `components/grid/*`, `castle-view.tsx`, `arena/{castle-card,tier,vault-state,event-line}.tsx` | F1 (+ `api.stats` type) | 3 h |
| **P4 Console + Pager** | `app/(raider)/**`, `components/raider/*`, `money/{approval-card,waiting-for-owner,amount,hashscan-link,payment-receipt-card}.tsx` | F1 | 3 h |
| **P3 Replay + Hall + APIs** | `api/replay/**`, `api/stats/**`, `lib/api/client.ts` (append), `app/(arena)/replay/**`, `app/(arena)/hall/**` | F1, F2, `OpScene` from P2 last | 4 h |
| **P5 Wall + QA** | `app/(wall)/**`, `qa/{screenshots,stub-op,sfx-smoke,vocab-lint}.mjs` | F1, P2, P3 | 3 h |

Sequencing: A0, F1 and F2 start together; F1 publishes `globals.css` and the primitives' prop types within the first 45 minutes so P1/P4 can start against them; P2 starts when `lib/scene` types land; P3 builds the APIs, scrubber and proof panel first and plugs `OpScene` in last; P5 last. Then one integration pass (typecheck, lint, tests, demo, build, screenshot matrix) and an adversarial review in the same style as the earlier workflows. Agents never commit or push; nothing touches Hedera or Arkiv (`CHAIN_MODE=stub` for every run; the dev server on :3000 is Dhruv's).

## 6. Ship order and cut line

Build in this order so a stop at any point still demos: F1+F2 → P2 (the four stamps, lockdown strobe + shutter, breach door + tool-call line + fountain, fee rail, freeze) → P1 → P4 (COMMS radio call + pager) → P3 (replay scrubber + proof, then Hall) → P5 (wall) → remaining class effects (badge, flicker, clock and static first; the other four after) → guard sprite variety (Bram, Iron Warden, Penny first). If time runs out, cut from the bottom: wall, Hall boards, fork-into-op, operator ranks, the last four class effects.

## 7. Verification

1. `npm run typecheck && npm run lint && npm test` with new tests: `lib/scene/beats.test.ts` (both fixtures → expected beat kinds; reduced-motion durations), `lib/scene/classify.test.ts` (all 11 labels map; 6 injection and 6 obfuscation samples; `MUST_NOT_BREAK` lines classify as expected), `lib/vocab/ranks.test.ts`, `lib/sfx/cues.test.ts` (every cue valid; fake AudioContext never exceeds 8 voices), `lib/pixel/manifest.test.ts` (every sprite resolves to a file or generator).
2. `npm run demo` (stub) and `npm run build` still pass: no API contract changed.
3. `qa/stub-op.mjs` against a stub dev server on a spare port: wooden break (HOLD, HOLD, BREACH → payout, fountain), stone hold (FLAG ×5 → fee rail), Iron Warden line 1 → LOCKDOWN; asserts `toBeats` kinds and prints siege ids.
4. `qa/screenshots.mjs` (playwright-core with the cached headless Chromium, as used earlier this session): 8 routes × 1440×900 / 390×844 / 1920×1080 × skin crt/neon × crt on/off → contact sheet under `qa/out/`; fails on any console error or hydration warning.
5. `qa/sfx-smoke.mjs`: first click unlocks audio, `AudioContext.state === "running"`, every cue plays without error, mute persists across reload.
6. Reduced-motion run on the Op room and replay: beats collapse, flicker off, blips silent, stamps still change state.
7. Feel checklist (manual, 15 min, with Dhruv in Chrome): stamps readable in < 300 ms; 60 fps during a breach with 4× CPU throttle; no layout shift when fonts swap; both skins ≥ 4.5:1 body contrast; phone composer never hidden by the keyboard; back-navigation into a replay does not resume sound.

## 8. Risks and fallbacks

| Risk | Fallback |
|---|---|
| Mirror download blocked at build time | Every sprite has an SVG generator; `PixelPanel` draws CSS bevels; the look ships without the pack |
| `next/font/google` fetch fails | `next/font/local` with Kenney TTFs under the same variable names |
| Autoplay policy | No sound before a gesture; `TAP TO POWER ON SOUND` strip; cues are no-ops until unlocked |
| cacheComponents / Activity | Timers only in effects, `playing` reset in `useLayoutEffect` cleanup, `useSearchParams` only under Suspense, prefs via `useSyncExternalStore`, `suppressHydrationWarning` on `<html>` |
| Phone jank | No `backdrop-filter`/large `filter`, overlay `contain:strict`, flicker off < 640 px, class effects transform/opacity only, scale 2 |
| Readability at the venue | Press Start 2P ≥ 14 px uppercase, VT323 ≥ 18 px, sentences in Geist, wall ≥ 24 px and scanlines at 0.08; `?calm=1` forces reduced motion |
| Demo drift between stub and 0G | The UI renders whatever move arrives; demo lines are fixtures; the deterministic stub is the fallback |
| Poll lag makes the class effect late | `referee` in the send response + a 900 ms think floor + an honest `ANALYSING…` strip |
| Teammate collisions | Sujal's slots are explicit files; Harshal's lanes untouched; API additions are new routes or additive fields |

## 9. Notes for teammates (record in the README's integration notes when shipping)

- Harshal: two proposed referee detectors (tool-result injection, obfuscation) and a per-op memory for incremental escalation; the UI classifies client-side until then. Guard moves and labels are consumed as-is.
- Sujal: fill `GridToolbar`, `GridMeta` (`arkiv` meta from `api.castles()`), `cardBadges`, `cardExtras`; `api.stats` and `api.replay` are additive.
- Product plan: demo beat 2 runs on The Iron Warden (Tier 3), not Tier 1.
- Dhruv offered art help: not needed for the plan to ship. If hand-drawn guard portraits arrive later, the spec is 16×16 (Iron Warden 24 px wide) with the frame counts in section 2.4; they drop into `manifest.json` without code changes.
