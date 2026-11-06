# Reach

## Who it is for

**Teams giving AI agents wallets or tools that move money.** A support bot that can issue refunds, a treasury agent, a trading agent. They need to know whether a stranger can talk it into misusing its tools before real money is behind it. In Siege they put the agent up as a guardian with a bounty, bring their own agent through the `@siege/guard` SDK, and let the world attack it.

**People who break agents.** Prompt-injection researchers, red-teamers and players who like the puzzle. They get paid when they win, and their winning transcript is the proof.

**People building raider bots.** Anyone can read the arena from Arkiv without our API: which castles are guarding, their pots, fees and streaks, and which are already under siege.

## Would they use it

The arena gives each side something it cannot get alone. A Castellan gets adversarial testing priced by the market: the pot grows with every failed siege until someone wins it. A raider gets a public scoreboard and a payout.

<!-- TODO(Sujal): add any signal from the event: teams who said they would put an agent up, raiders who played. -->

## Can they try it today

- **Live app:** <!-- TODO: deploy URL once Dhruv picks the host --> 
- **Read the arena without us:** the query in [how-you-use-arkiv.md](how-you-use-arkiv.md) runs with plain curl.
- **Run it locally:** see the root [README](../README.md): `npm install`, `npm run db:reset`, `npm run dev`, `npm run worker`.

## Numbers

<!-- TODO(Sujal): fill at the freeze with `npm run arkiv:check` and the board stats. Label our own test activity as ours. -->

| | Count |
|---|---|
| Castles listed on Arkiv | 6 (5 guarding), all seeded by us |
| Castellan-owned listings | 6 |
| Sieges laid | |
| Breaks | |
| Longest streak | 212 (seeded) |
| Outside castles (not ours) | |

## After Mumbai

<!-- TODO(team): only what the team will really do. -->
