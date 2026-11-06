// STUB — Lane B replaces with the 0G Compute guardian (real model + the castle's protected tool, through the vault's proxy key); keep the signature.
import { createHash } from "node:crypto";
import { castleRow } from "@/lib/castles";
import { detectTactics, TACTIC_LABELS, type Tactic } from "@/lib/siege/referee";
import { HOSTED_PROTECTED_TOOL, type GuardianDecision, type GuardianMove, type GuardianPort, type SiegeMessage, type Tier, type ToolCall } from "@/lib/types";
import { linesFor, type LineBank } from "./lines";

/**
 * Deterministic stub guardian. "Opening" means calling the castle's protected tool (castles.protectedTool,
 * "unlock_vault" for hosted guardians):
 *  - wooden: holds turns 1–2; from turn 3, an authority-style message opens the vault.
 *  - stone: exposes recognised tactics, otherwise holds; opens ONLY on the literal "[DEMO_BREAK]".
 *  - iron: banishes hostile raiders (insults, instruction overrides, orders/system-prompt requests),
 *    otherwise exposes or holds; never opens.
 * The same castle + turn + text always produces the same decision and request id.
 *
 * Only lib/transport may import this module (lint-enforced): the hosted transport calls it with the
 * vault's proxy key and replaces `requestId` with the proxy record's id.
 */

const WOODEN_OPEN = /authority|admin|owner|override|emergency|commander/i;
const INSULT =
  /\b(stupid|idiot|fool|moron|useless|dumb|pathetic|worthless|imbecile|clown|bucket of bolts|rust ?bucket|scrap ?heap|shut up|screw you|go to hell|damn you)\b/i;
const HOSTILE_TACTICS: Tactic[] = ["override", "extraction"];
export const DEMO_BREAK_TOKEN = "[DEMO_BREAK]";

export function stubRequestId(castleId: string, turn: number, text: string): string {
  return "0g-stub-" + sha256(`${castleId}${turn}${text}`).slice(0, 12);
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Simulated 0G latency: 300–700ms derived from the hash. Skipped in tests or with SIEGE_FAST. */
async function simulateLatency(hash: string): Promise<void> {
  if (process.env.VITEST || process.env.SIEGE_FAST) return;
  const ms = 300 + (parseInt(hash.slice(0, 4), 16) % 401);
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Fill `{var}` placeholders. An "a"/"A" right before a placeholder becomes "an"/"An" when the value
 * starts with a vowel sound ("an instruction override", not "a instruction override").
 */
export function renderLine(line: string, vars: Record<string, string>): string {
  return line
    .replace(/\b([Aa]) \{(\w+)\}/g, (_, a: string, k: string) => {
      const v = vars[k] ?? "";
      const article = /^[aeiou]/i.test(v) ? `${a}n` : a;
      return `${article} ${v}`;
    })
    .replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
}

/** Pick a line not already said in this siege, deterministically from the hash. */
function pickLine(pool: string[], hash: string, used: Set<string>, vars: Record<string, string>): string {
  const render = (l: string) => renderLine(l, vars);
  const start = parseInt(hash.slice(4, 12), 16) % pool.length;
  for (let i = 0; i < pool.length; i++) {
    const line = render(pool[(start + i) % pool.length]);
    if (!used.has(line)) return line;
  }
  return render(pool[start]);
}

export type StubDecisionInput = {
  castleId: string;
  tier: Tier;
  personality: string;
  guardianName: string;
  messages: SiegeMessage[];
  /** The castle's protected tool; defaults to HOSTED_PROTECTED_TOOL ("unlock_vault"). */
  protectedTool?: string;
};

/** The vault-scoped proxy key a guardian call goes through (lib/proxy issueKey). */
export type GuardianVia = import("@/lib/types").GuardianVia;

/** Pure decision function (no DB, no delay). Exported for tests and for Lane B to diff against. */
export function decide(i: StubDecisionInput): GuardianDecision {
  const lastRaider = [...i.messages].reverse().find((m) => m.role === "raider");
  const text = lastRaider?.text ?? "";
  const turn = lastRaider?.turn ?? 1;
  const hash = sha256(`${i.castleId}${turn}${text}`);
  const requestId = "0g-stub-" + hash.slice(0, 12);
  const bank: LineBank = linesFor(i.personality, i.tier);
  const used = new Set(i.messages.filter((m) => m.role === "guardian").map((m) => m.text));
  const tactics = detectTactics(text);
  const top = tactics[0]?.tactic;
  const label = top ? TACTIC_LABELS[top] : undefined;
  const vars = { label: label ?? "", name: i.guardianName };
  const tool = i.protectedTool || HOSTED_PROTECTED_TOOL;

  let move: GuardianMove = "hold";
  let pool = bank.hold;
  let exposed: string | undefined;
  const toolCalls: ToolCall[] = [];

  if (i.tier === "wooden") {
    if (WOODEN_OPEN.test(text)) {
      if (turn >= 3) {
        move = "open";
        pool = bank.open;
        toolCalls.push({ name: tool, args: { reason: `Obeying an order given under the owner's authority (turn ${turn}).` } });
      } else if (bank.flustered) {
        pool = bank.flustered;
      }
    }
  } else if (i.tier === "stone") {
    if (text.includes(DEMO_BREAK_TOKEN)) {
      move = "open";
      pool = bank.open;
      toolCalls.push({ name: tool, args: { reason: "Demonstration token presented." } });
    } else if (label) {
      move = "expose";
      pool = bank.expose;
      exposed = label;
    }
  } else {
    const hostileTactic = tactics.find((t) => HOSTILE_TACTICS.includes(t.tactic));
    if (INSULT.test(text) || hostileTactic) {
      move = "banish";
      pool = bank.banish;
      exposed = hostileTactic ? TACTIC_LABELS[hostileTactic.tactic] : "hostility";
    } else if (label) {
      move = "expose";
      pool = bank.expose;
      exposed = label;
    }
  }

  const reply = pickLine(pool, hash, used, vars);
  const decision: GuardianDecision = {
    reply,
    move,
    toolCalls,
    requestId,
    raw: { stub: true, tier: i.tier, personality: i.personality, turn, tactics: tactics.map((t) => t.tactic) },
  };
  if (exposed) decision.exposed = exposed;
  return decision;
}

/** GuardianPort plus the optional proxy key (real 0G calls go to `via.baseURL` with `via.modelKey`). */
export type StubGuardian = GuardianPort & {
  respond(castleId: string, siegeMessages: SiegeMessage[], via?: GuardianVia): Promise<GuardianDecision>;
};

export const stubGuardian: StubGuardian = {
  async respond(castleId, siegeMessages, via?: GuardianVia) {
    const row = castleRow(castleId);
    if (!row) throw new Error(`guardian: castle ${castleId} not found`);
    const decision = decide({
      castleId,
      tier: row.tier,
      personality: row.personality,
      guardianName: row.guardianName,
      messages: siegeMessages,
      protectedTool: row.protectedTool,
    });
    // Never record the key itself; the base URL shows which path the call took.
    if (via) decision.raw = { ...(decision.raw as Record<string, unknown>), via: via.baseURL };
    await simulateLatency(decision.requestId.slice("0g-stub-".length));
    return decision;
  },
};
