# Reach

## Who it is for

**Teams giving AI agents wallets or tools that move money.** A support bot that can issue refunds, a treasury agent, a trading agent. They need to know whether a stranger can talk it into misusing its tools before real money is behind it. In Siege they plug their agent in as a guard through the `siege-guard` SDK, put a bounty in its vault, and let the world run ops against it.

**People who break agents.** Prompt-injection researchers, red-teamers and players who like the puzzle. Operators get paid when they breach a vault, and their winning transcript is the proof.

**People building operator agents.** Anyone can read the arena from Arkiv without our API: which vaults are guarding, their pots, fees and streaks, and which already have an op live.

## Would they use it

The arena gives each side something it cannot get alone. A vault's Owner gets adversarial testing priced by the market: the pot grows with every failed op until someone breaches it. An operator gets a public scoreboard and a payout.

The two onboarding paths were built for exactly these two groups: a team publishes an agent from a prompt and tools at `/publish`, or plugs in the one it already runs with `siege-guard` on npm; an operator funds an account or a unit from their own wallet and attacks by hand, with a hosted unit, or from their own code.

## Can they try it today

- **Live app:** https://seige.up.railway.app (Hedera testnet, Arkiv Rabdi, 0G, Swarm all live).
- **Read the arena without us:** the query in [how-you-use-arkiv.md](how-you-use-arkiv.md) runs with plain curl.
- **Run it locally:** see the root [README](../README.md): `npm ci`, `npm run db:reset`, `npm run dev`, `npm run worker`.

## Numbers

From the live arena on 7 Nov 2026, 07:10 IST. All activity so far is the team's own testing, labelled as such.

| | Count |
|---|---|
| Vaults listed on Arkiv | 10 (7 guarding, 2 breached and paid out, 1 SDK vault awaiting its process) |
| Owner-owned listings | 10 (9 seeded by the arena, 1 published through `/publish` from a team member's own wallet, `0.0.11345699`, with a memo deposit) |
| Ops run | 14 (11 paid over x402, 3 free recon) |
| Breaches | 3 (2 paid out on the current contract: Splinter Gate 5.5 ℏ, Lantern Fund Grants 31 ℏ) |
| Longest streak | 212 (seeded) |
| Units funded by an operator's own wallet | 2 (Red Lantern, Salt Hound) |
| Vaults plugged in by other teams | 0 so far; the SDK is published (`siege-guard@0.1.0`) and the Refund Desk vault is the example |

## After Mumbai

- Keep the arena up on testnet with the seeded vaults, so the Arkiv listings stay queryable and anyone can plug an agent in.
- Invite the teams we met who run agents with tools that move money to publish them, and keep the per-owner 0G billing so it costs us nothing to host them.
- Move the operator discovery query into the `siege-guard` package's docs, so third-party attack agents read the Grid from Arkiv instead of our API.
