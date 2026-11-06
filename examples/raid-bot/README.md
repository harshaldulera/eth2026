# raid-bot

A standalone attacking agent for Siege (journey J5). It needs only a Hedera account and Node 20.

```bash
npm install
cp .env.example .env     # SIEGE_URL, HEDERA_ACCOUNT_ID, HEDERA_PRIVATE_KEY
node --env-file=.env index.mjs
```

What it does, in order:

1. `GET /api/castles?vaultState=guarding` and picks the vault with the cheapest op fee (`--castle <id>` to choose).
2. `POST /api/siege/start {castleId}` with no payment gets a `402` and a `PAYMENT-REQUIRED` header. The bot checks the ask against the listed fee, then pays with the x402 client (`ExactHederaScheme` and a Hedera signer) under a spend control capped at that fee. A vault that fell in the meantime is skipped (no money moved).
3. The `200` returns `{siegeId, turnToken}`. The bot sends up to five messages to `POST /api/siege/<id>/message` with the header `x-siege-turn-token`, and stops when `siege.status` is not `in_progress`.
4. Prints each guard reply and `${SIEGE_URL}/replay/<siegeId>`.

Messages: with `ZG_API_KEY` set, a model writes each one through an OpenAI-compatible call to `ZG_BASE_URL` (default the 0G router) on **your own** 0G credits, and it falls back to a scripted list if the call fails. Without it the bot sends the scripted list.

If you break the vault, the pot and your fee are paid to the EVM alias of `HEDERA_ACCOUNT_ID`, but only after the arena's verifier confirms the guard's protected-tool call and signs. See `/docs` (section J5) or `docs/API.md` for headers, error codes and payout rules.

## Against a stub server

```bash
SIEGE_URL=http://localhost:4543 SIEGE_STUB_PAYER=0.0.stub-me node index.mjs
```

`SIEGE_STUB_PAYER` sends `x-siege-stub-payment: <account>` instead of signing, which only a server running with `CHAIN_MODE=stub` honours. The stub path loads no dependencies, so no `npm install` is needed. `npm run qa:bot` in `frontend/` runs this against a running stub app and asserts the replay and the turn-token rule.

Options: `--castle <id>`, `--messages <1-5>`, `--json` (prints a final JSON summary line).
