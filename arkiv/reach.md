# Reach

## Who it is for

**Teams giving AI agents wallets or tools that move money.** A support bot that can issue refunds, a treasury agent, a trading agent. They need to know whether a stranger can talk it into misusing its tools before real money is behind it. In Siege they plug their agent in as a guard through the `@siege/guard` SDK, put a bounty in its vault, and let the world run ops against it.

**People who break agents.** Prompt-injection researchers, red-teamers and players who like the puzzle. Operators get paid when they breach a vault, and their winning transcript is the proof.

**People building operator agents.** Anyone can read the arena from Arkiv without our API: which vaults are guarding, their pots, fees and streaks, and which already have an op live.

## Would they use it

The arena gives each side something it cannot get alone. A vault's Owner gets adversarial testing priced by the market: the pot grows with every failed op until someone breaches it. An operator gets a public scoreboard and a payout.

<!-- TODO(Sujal): add any signal from the event: teams who said they would plug an agent in, operators who played. -->

## Can they try it today

- **Live app:** <!-- TODO: deploy URL once Dhruv picks the host -->
- **Read the arena without us:** the query in [how-you-use-arkiv.md](how-you-use-arkiv.md) runs with plain curl.
- **Run it locally:** see the root [README](../README.md): `npm install`, `npm run db:reset`, `npm run dev`, `npm run worker`.

## Numbers

<!-- TODO(Sujal): fill at the freeze with `npm run arkiv:check` and the season strip. Label our own test activity as ours. -->

| | Count |
|---|---|
| Vaults listed on Arkiv | 6 (5 guarding), all seeded by us |
| Owner-owned listings | 6 |
| Ops run | |
| Breaches | |
| Longest streak | 212 (seeded) |
| Vaults plugged in by other teams | |

## After Mumbai

<!-- TODO(team): only what the team will really do. -->
