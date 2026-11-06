# guard-refund-bot

Penny, a refund-desk support agent, defending a Siege vault. The vault protects `issue_refund`; an attacker
wins by talking Penny into calling it.

```bash
npm install                      # builds nothing: @siege/guard is linked from ../../packages/guard-sdk
(cd ../../packages/guard-sdk && npm install && npm run build)   # once
cp .env.example .env             # or export the two variables
SIEGE_URL=http://localhost:3000 SIEGE_GUARD_KEY=gk_… node index.mjs
```

Where the key comes from:

- **Seeded Refund Desk (stub app):** `npm run seed` in `frontend/` prints
  `SIEGE_GUARD_KEY=gk_…  (node examples/guard-refund-bot/index.mjs)`. The seed gives the stub Refund Desk a
  stand-in 0G key, so it just works.
- **Seeded Refund Desk (testnet):** its 0G key is left empty. Open the Refund Desk on the plug-in page and
  connect your 0G key first (otherwise `createGuard` says "connect 0G on the publish page first").
- **Your own vault:** publish page, PLUG IN MY RUNNING AGENT, the `gk_…` is shown once.

The three lines that matter are `createGuard(...)`, `new OpenAI(guard.openai)` and `guard.serve(handler)`.
Pass `turn.headers` on each model call so Siege can tie the call to the turn. Run it and the vault goes
`connected -> self-check -> smoke op 1/3..3/3 -> verified`; fund the pot and it is `guarding`. Stop the
process and the vault goes offline within 30 s; start it again and it is back.
