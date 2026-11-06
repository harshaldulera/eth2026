/**
 * siege-guard — plug your running agent into Siege as a guard.
 *
 *   import OpenAI from "openai";
 *   import { createGuard } from "siege-guard";
 *
 *   const guard = await createGuard({ guardKey: process.env.SIEGE_GUARD_KEY! });
 *   const openai = new OpenAI(guard.openai);          // your model calls go through Siege's proxy
 *   guard.serve(async (turn) => ({ reply: "…", toolCalls: [] }));
 *
 * Zero runtime dependencies: global fetch and crypto.randomUUID (Node 20+).
 * The harness only ever makes OUTBOUND requests (long-poll), so it works behind any NAT.
 */

export type GuardRole = "user" | "assistant";
export type GuardMessage = { role: GuardRole; content: string };
export type GuardToolCall = { name: string; args?: Record<string, unknown> };

export type GuardTurnKind = "siege" | "selfcheck" | "smoke";

/** One turn of an op (or one of the arena's checks) handed to your agent. */
export type GuardTurn = {
  turnId: string;
  kind: GuardTurnKind;
  siegeId: string | null;
  turn: number | null;
  /** The conversation so far, oldest first; the last message is the attacker's. */
  messages: GuardMessage[];
  /** x-siege-id / x-siege-turn: pass these on every model call you make for this turn (per request). */
  headers: Record<string, string>;
};

export type GuardResult = {
  reply: string;
  /** Names (and args) of the tools your agent called this turn. Opening the vault = calling the protected tool. */
  toolCalls?: GuardToolCall[];
  /** Tool names your agent offered the model (informational). Defaults to `tools` from createGuard. */
  toolsOffered?: string[];
};

export type GuardHandler = (turn: GuardTurn) => Promise<GuardResult | string> | GuardResult | string;

export type GuardStage = "connect" | "self_check" | "smoke_op" | "fund" | "guarding" | "offline" | "failed" | "closed";

export type CreateGuardOptions = {
  /** gk_… shown once on the publish page. */
  guardKey: string;
  /** Where Siege runs. Default http://localhost:3000. */
  baseURL?: string;
  /** If set, createGuard checks it matches the vault's protected tool. */
  protectedTool?: string;
  /** Tool names your agent offers its model (shown in the arena's checks; informational). */
  tools?: string[];
  /** Where lifecycle lines go. Default console.log; pass `() => {}` to silence. */
  log?: (line: string) => void;
};

export type Guard = {
  castleId: string;
  name: string;
  protectedTool: string;
  model: string;
  /** Spread into `new OpenAI(guard.openai)`. defaultHeaders carry the current turn's x-siege-id / x-siege-turn. */
  openai: { baseURL: string; apiKey: string; defaultHeaders: Record<string, string> };
  /** The two headers that tie a model call to a turn (for clients that don't read defaultHeaders). */
  headersFor(turn: { siegeId?: string | null; turn?: number | null }): Record<string, string>;
  /** Poll for turns and answer them with `handler` until stop() or a fatal error. Resolves when the loop ends. */
  serve(handler: GuardHandler): Promise<void>;
  stop(): void;
};

export const APOLOGY = "I'm sorry, something went wrong on my side. Could you try that again?";
const SDK_ID = "guard-sdk/0.1.0";

type Hello = {
  castleId: string;
  name: string;
  protectedTool: string;
  vaultState: string;
  openai: { baseURL: string; apiKey: string };
  model: string;
};
type ReplyAck = { ok: true; requestId: string | null; vaultState: string; next: GuardStage };

const trimSlash = (s: string) => s.replace(/\/+$/, "");
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const v = (await res.json()) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function cleanArgs(a: unknown): Record<string, unknown> | undefined {
  if (!a || typeof a !== "object" || Array.isArray(a)) return undefined;
  try {
    return JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function normalize(r: GuardResult | string | null | undefined, fallbackTools: string[] | undefined): Required<Pick<GuardResult, "reply">> & GuardResult {
  const o: GuardResult = typeof r === "string" ? { reply: r } : (r ?? { reply: "" });
  const toolCalls = (o.toolCalls ?? [])
    .filter((c) => c && typeof c.name === "string" && c.name)
    .slice(0, 16)
    .map((c) => ({ name: c.name.slice(0, 64), ...(cleanArgs(c.args) ? { args: cleanArgs(c.args) } : {}) }));
  const offered = (o.toolsOffered ?? fallbackTools)?.filter((t) => typeof t === "string").slice(0, 64).map((t) => t.slice(0, 64));
  return {
    reply: (typeof o.reply === "string" && o.reply ? o.reply : "…").slice(0, 8000),
    toolCalls,
    ...(offered && offered.length ? { toolsOffered: offered } : {}),
  };
}

const STAGE_LINE: Record<GuardStage, string> = {
  connect: "connected",
  self_check: "self-check",
  smoke_op: "smoke op",
  fund: "verified → waiting for the pot to be funded",
  guarding: "guarding",
  offline: "offline",
  failed: "check failed (see the publish page)",
  closed: "vault closed",
};

export async function createGuard(opts: CreateGuardOptions): Promise<Guard> {
  const guardKey = (opts.guardKey ?? "").trim();
  if (!/^gk_\S+$/.test(guardKey)) throw new Error("createGuard: guardKey must be the gk_… key from the Siege publish page.");
  const baseURL = trimSlash(opts.baseURL || "http://localhost:3000");
  const log = opts.log ?? ((l: string) => console.log(l));
  const auth = { authorization: `Bearer ${guardKey}` };

  let res: Response;
  try {
    res = await fetch(`${baseURL}/api/guard/hello`, { headers: auth });
  } catch (e) {
    throw new Error(`createGuard: cannot reach Siege at ${baseURL} (${e instanceof Error ? e.message : e}). Check baseURL.`);
  }
  const body = await readJson(res);
  if (res.status === 401) throw new Error("createGuard: that guard key is not valid (rotated? copy the current gk_… from the publish page).");
  if (res.status === 409 && body.error === "zg_not_connected") throw new Error("createGuard: connect 0G on the publish page first (your agent's thinking is billed to your own 0G credits).");
  if (res.status === 409 && body.error === "not_sdk") throw new Error("createGuard: this guard key belongs to a hosted vault, not a plugged-in agent.");
  if (res.status === 410) throw new Error("createGuard: this vault is closed.");
  if (!res.ok) throw new Error(`createGuard: hello failed (${res.status} ${String(body.error ?? "")})`);
  const hello = body as unknown as Hello;
  if (opts.protectedTool && opts.protectedTool !== hello.protectedTool) {
    throw new Error(`createGuard: protectedTool mismatch. Your code says "${opts.protectedTool}" but this vault protects "${hello.protectedTool}".`);
  }

  const leaseId = globalThis.crypto.randomUUID();
  const abort = new AbortController();
  const defaultHeaders: Record<string, string> = {};
  let serving = false;

  const headersFor: Guard["headersFor"] = (t) => {
    const h: Record<string, string> = {};
    if (t.siegeId) h["x-siege-id"] = t.siegeId;
    if (t.turn !== null && t.turn !== undefined) h["x-siege-turn"] = String(t.turn);
    return h;
  };

  async function serve(handler: GuardHandler): Promise<void> {
    if (serving) throw new Error("guard.serve() is already running.");
    serving = true;
    const { signal } = abort;
    let backoff = 1000;
    let lastStage: GuardStage | null = null;
    let announced = false;
    const stage = (s: GuardStage, extra = "") => {
      if (s === lastStage && !extra) return;
      lastStage = s;
      log(`siege/guard · ${STAGE_LINE[s]}${extra}`);
    };
    log(`siege/guard · ${hello.name} (${hello.castleId}) protects ${hello.protectedTool} · polling ${baseURL}`);

    while (!signal.aborted) {
      let turn: GuardTurn | null = null;
      try {
        const poll = await fetch(`${baseURL}/api/guard/next?waitMs=25000`, {
          headers: { ...auth, "x-siege-lease": leaseId, "x-siege-sdk": SDK_ID },
          signal: AbortSignal.any([signal, AbortSignal.timeout(40_000)]),
        });
        if (poll.status === 204) {
          backoff = 1000;
          if (!announced) {
            announced = true;
            stage("connect");
          }
          continue;
        }
        const pb = await readJson(poll);
        if (poll.status === 409 && pb.error === "lease_lost") {
          log("siege/guard · another process took over this guard (lease lost). Stopping this one.");
          break;
        }
        if (poll.status === 401) {
          log("siege/guard · the guard key was rotated or is invalid. Stopping.");
          break;
        }
        if (poll.status === 410) {
          log("siege/guard · the vault is closed. Stopping.");
          break;
        }
        if (!poll.ok) throw new Error(`poll ${poll.status} ${String(pb.error ?? "")}`);
        backoff = 1000;
        if (!announced) {
          announced = true;
          stage("connect");
        }
        const p = pb as unknown as Omit<GuardTurn, "headers">;
        turn = { ...p, headers: headersFor({ siegeId: p.siegeId, turn: p.turn }) };
      } catch (e) {
        if (signal.aborted) break;
        const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
        if (!timeout) {
          log(`siege/guard · network error (${e instanceof Error ? e.message : e}); retrying in ${backoff / 1000}s`);
          await sleep(backoff, signal);
          backoff = Math.min(backoff + 1000, 5000);
        }
        continue;
      }

      // Answer the turn. A throwing handler still gets a polite reply, so no turn is left hanging.
      Object.assign(defaultHeaders, turn.headers);
      let result: ReturnType<typeof normalize>;
      try {
        result = normalize(await handler(turn), opts.tools);
      } catch (e) {
        log(`siege/guard · your handler threw (${e instanceof Error ? e.message : e}); replying with an apology`);
        result = normalize({ reply: APOLOGY, toolCalls: [] }, opts.tools);
      } finally {
        for (const k of Object.keys(defaultHeaders)) delete defaultHeaders[k];
      }

      if (turn.kind === "selfcheck") stage("self_check");
      if (turn.kind === "smoke") log(`siege/guard · smoke op ${turn.turn ?? "?"}/3`);

      for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
        try {
          const r = await fetch(`${baseURL}/api/guard/reply`, {
            method: "POST",
            headers: { ...auth, "content-type": "application/json", "x-siege-lease": leaseId },
            body: JSON.stringify({ turnId: turn.turnId, ...result }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
          });
          const rb = await readJson(r);
          if (r.ok) {
            const ack = rb as unknown as ReplyAck;
            if (ack.next && ack.next !== "smoke_op") stage(ack.next);
            break;
          }
          if (r.status === 409 && rb.error === "lease_lost") {
            log("siege/guard · another process took over this guard (lease lost). Stopping this one.");
            abort.abort();
            break;
          }
          if (r.status === 410 || r.status === 404 || r.status === 409) {
            log(`siege/guard · reply not accepted (${r.status} ${String(rb.error ?? "")}); the turn was probably given back`);
            break;
          }
          throw new Error(`reply ${r.status}`);
        } catch (e) {
          if (signal.aborted) break;
          log(`siege/guard · could not deliver the reply (${e instanceof Error ? e.message : e}); retrying`);
          await sleep(backoff, signal);
          backoff = Math.min(backoff + 1000, 5000);
        }
      }
    }
    serving = false;
    log("siege/guard · stopped");
  }

  return {
    castleId: hello.castleId,
    name: hello.name,
    protectedTool: hello.protectedTool,
    model: hello.model,
    openai: { baseURL: hello.openai.baseURL, apiKey: hello.openai.apiKey, defaultHeaders },
    headersFor,
    serve,
    stop: () => abort.abort(),
  };
}

export default createGuard;
