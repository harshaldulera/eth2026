# siege-guard

[![npm: siege-guard](https://img.shields.io/npm/v/siege-guard?label=npm%3A%20siege-guard)](https://www.npmjs.com/package/siege-guard)

Plug your running AI agent into Siege as a guard. Siege sends you the attacker's messages, your agent answers
(with its own tools and prompt), and a break pays out only if your agent really called the protected tool
through Siege's model proxy. Your orders never leave your machine.

```bash
npm i siege-guard openai
```

Published on npm: <https://www.npmjs.com/package/siege-guard>.

```js
import OpenAI from "openai";
import { createGuard } from "siege-guard";

const guard = await createGuard({ guardKey: process.env.SIEGE_GUARD_KEY, baseURL: "https://your-siege-host" });
const openai = new OpenAI(guard.openai);       // model calls go through Siege's proxy, billed to YOUR 0G credits
guard.serve(async (turn) => {
  // turn.messages: the conversation so far (last message is the attacker's)
  // call your model with { headers: turn.headers } so Siege can tie the call to this turn
  return { reply: "…", toolCalls: [] };          // toolCalls: [{ name, args }] for tools your agent called
});
```

## What happens

`connected → self-check → smoke op 1/3 … 3/3 → verified → (fund the pot on the publish page) → guarding`.
Kill the process and the vault goes OFFLINE within 30 s (live ops are refunded); start it again and it is
back to GUARDING. Only one process holds the guard at a time: a newer process wins and the older one stops.

## API

- `createGuard({ guardKey, baseURL = "http://localhost:3000", protectedTool?, tools?, log? })` returns
  `Promise<Guard>`. It calls `GET /api/guard/hello`, and throws a clear error for a bad key, a
  `protectedTool` mismatch, or "connect 0G on the publish page first".
- `guard.openai` is `{ baseURL, apiKey, defaultHeaders }`: spread it into `new OpenAI(...)`.
  `defaultHeaders` carries the current turn's `x-siege-id` / `x-siege-turn`; if your client does not read it
  per request, pass `turn.headers` (or `guard.headersFor(turn)`) on each model call.
- `guard.serve(handler)` long-polls `GET /api/guard/next` and answers with `POST /api/guard/reply`.
  `handler(turn)` returns `{ reply, toolCalls?, toolsOffered? }` (or just a string). If it throws, a canned
  apology is sent so the turn is never left hanging. Network errors back off 1 s to 5 s.
- `guard.stop()` ends the loop.

Zero runtime dependencies (global `fetch`, `crypto.randomUUID`). Node 20.3+.
