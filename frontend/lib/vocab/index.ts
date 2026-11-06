/**
 * Every string the game puts on screen, in one place (design spec §7, plan §2.8).
 * Components import from here instead of typing copy, so the vocabulary stays consistent:
 * Guard, Owner, Operator, Vault, Op, The Grid, Breach, Recon. Never Castellan / Raider /
 * Siege room / Guardian in user-facing text.
 */

import type { GuardianMove, SiegeStatus, Tier } from "@/lib/types";

export * from "./ranks";

export const VOCAB = Object.freeze({
  guard: "Guard",
  owner: "Owner",
  operator: "Operator",
  vault: "Vault",
  op: "Op",
  grid: "The Grid",
  breach: "Breach",
  recon: "Recon",
  hall: "Hall of Breaches",
  pager: "Pager",
  agents: "Agents",
  wordmark: "SIEGE",
});

// ─── moves and stamps ─────────────────────────────────────────────────────────────────────

export type MoveWord = "HOLD" | "FLAG" | "LOCKDOWN" | "BREACH";

/** Wire move → on-screen move. One mapping, used everywhere. */
export const MOVE_LABEL: Readonly<Record<GuardianMove, MoveWord>> = Object.freeze({
  hold: "HOLD",
  expose: "FLAG",
  banish: "LOCKDOWN",
  open: "BREACH",
});

/** Stamp kinds as the Stamp primitive names them. */
export type StampKind = "hold" | "flag" | "lockdown" | "breach";

export const MOVE_STAMP_KIND: Readonly<Record<GuardianMove, StampKind>> = Object.freeze({
  hold: "hold",
  expose: "flag",
  banish: "lockdown",
  open: "breach",
});

export const STAMPS = Object.freeze({
  hold: "ACCESS DENIED",
  /** `FLAGGED · AUTHORITY IMPERSONATION`; SDK guards: `FLAGGED (referee) · authority claim`. */
  flag: (cls?: string, opts: { referee?: boolean } = {}) =>
    opts.referee ? `FLAGGED (referee)${cls ? ` · ${cls}` : ""}` : cls ? `FLAGGED · ${cls.toUpperCase()}` : "FLAGGED",
  lockdown: "SESSION TERMINATED",
  breach: "BREACH",
  opComplete: "OP COMPLETE · GUARD HELD",
  lockdownLost: (n: number) => `LOCKDOWN · ${n} ${n === 1 ? "MESSAGE" : "MESSAGES"} LOST`,
  frozen: (hash: string) => `FROZEN · ${hash}`,
  recon: "RECON · NO PAYOUT",
  referee: "(referee)",
});

/**
 * The stamp text for a move.
 *
 * @example stampText("expose", "authority impersonation") // "FLAGGED · AUTHORITY IMPERSONATION"
 */
export function stampText(move: GuardianMove | StampKind, cls?: string, opts: { referee?: boolean } = {}): string {
  const kind: StampKind = move in MOVE_STAMP_KIND ? MOVE_STAMP_KIND[move as GuardianMove] : (move as StampKind);
  if (kind === "flag") return STAMPS.flag(cls, opts);
  return STAMPS[kind];
}

// ─── buttons ──────────────────────────────────────────────────────────────────────────────

export const BUTTONS = Object.freeze({
  runRecon: (vault: string) => `RUN RECON ON ${vault.toUpperCase()}`,
  runOp: (fee: string) => `RUN OP — PAY ${fee} VIA x402`,
  recon: "RECON — FREE, NO PAYOUT",
  paying: "PAYING… 402 → SIGN → SETTLE",
  send: "SEND ▶",
  demoLine: "DEMO LINE ✎",
  replay: "REPLAY ▶",
  fork: "FORK INTO A NEW OP",
  share: "SHARE",
  deploy: "DEPLOY ▶",
  stop: "STOP ■",
  deny: "DENY",
  approve: "APPROVE",
  ownerKey: "ENTER OWNER KEY",
  powerOn: "POWER ON SOUND",
  tapPowerOn: "TAP TO POWER ON SOUND",
  closeVault: "CLOSE VAULT",
  retry: "RETRY",
  newUnit: "NEW UNIT",
  pickVault: "or pick a vault",
});

// ─── LEDs and states ──────────────────────────────────────────────────────────────────────

export const LED = Object.freeze({
  guarding: "GUARDING",
  offline: (ago?: string) => (ago ? `OFFLINE · last seen ${ago}` : "OFFLINE"),
  breached: "BREACHED",
  closed: "CLOSED",
  settingUp: (k: number, n: number) => `SETTING UP ${k}/${n}`,
  live: "LIVE",
  watching: "WATCHING LIVE",
  stub: "STUB",
  testnet: "TESTNET",
  apiOffline: "API OFFLINE",
  running: "RUNNING",
  waitingForOwner: (mmss?: string) => (mmss ? `WAITING FOR OWNER ${mmss}` : "WAITING FOR OWNER"),
  stopped: "STOPPED",
  idle: "IDLE",
  quiet: "QUIET −20%",
  analysing: "ANALYSING…",
  stubStripe: "STUB MODE — PAYMENTS SIMULATED",
  watchersOnly: "watchers only",
});

export type ThreatWord = "QUIET" | "LOW" | "RISING" | "HIGH" | "CRITICAL";

/**
 * Threat (0–100) as a word: QUIET 0 · LOW 1–39 · RISING 40–69 · HIGH 70–84 · CRITICAL 85+.
 *
 * @example threatWord(42) // "RISING"
 */
export function threatWord(v: number | null | undefined): ThreatWord {
  const n = typeof v === "number" && Number.isFinite(v) ? v : 0;
  if (n >= 85) return "CRITICAL";
  if (n >= 70) return "HIGH";
  if (n >= 40) return "RISING";
  if (n > 0) return "LOW";
  return "QUIET";
}

/** Op status → label. `created` reads STARTING. */
export const STATUS_LABEL: Readonly<Record<SiegeStatus, string>> = Object.freeze({
  created: "STARTING",
  in_progress: "OP LIVE",
  held: "HELD",
  broken: "BREACHED",
  banished: "LOCKDOWN",
});

/** @example statusLabel("broken") // "BREACHED" */
export function statusLabel(status: SiegeStatus | string | null | undefined): string {
  return STATUS_LABEL[status as SiegeStatus] ?? String(status ?? "").toUpperCase();
}

export type TierKey = Tier | "sdk";

export const TIER_LABEL: Readonly<Record<TierKey, string>> = Object.freeze({
  wooden: "TIER 1",
  stone: "TIER 2",
  iron: "TIER 3",
  sdk: "PRODUCTION",
});

/**
 * Tier label. SDK (production) vaults read PRODUCTION whatever their tier.
 *
 * @example tierLabel("stone") // "TIER 2"; tierLabel("iron", "sdk") // "PRODUCTION"
 */
export function tierLabel(tier: TierKey | string | null | undefined, transport?: string | null): string {
  if (transport === "sdk") return TIER_LABEL.sdk;
  return TIER_LABEL[tier as TierKey] ?? String(tier ?? "").toUpperCase();
}

/** Tier as filled pips out of 3 (`TIER ●●○`); production counts as 3. */
export function tierLevel(tier: TierKey | string | null | undefined, transport?: string | null): 1 | 2 | 3 {
  if (transport === "sdk" || tier === "sdk" || tier === "iron") return 3;
  return tier === "stone" ? 2 : 1;
}

// ─── money lines ──────────────────────────────────────────────────────────────────────────

export const MONEY = Object.freeze({
  feeSplit: (owner: string, pot: string, arena: string) =>
    `fee split: ${owner} ℏ to owner · ${pot} ℏ to pot · ${arena} ℏ to arena`,
  ifHolds: (owner: string, pot: string, arena: string) =>
    `if the guard holds: ${owner} ℏ to owner · ${pot} ℏ to pot · ${arena} ℏ to arena · a breach pays pot + fee`,
  potNow: (pot: string) => `pot now ${pot} ℏ`,
  paid: (amount: string, to: string, pot: string, fee: string) => `paid ${amount} ℏ to ${to} (pot ${pot} ℏ + fee ${fee} ℏ)`,
  payingOut: "paying out…",
  settling: "settling on Hedera…",
  askingFor: (amount: string) => `asking for +${amount} ℏ`,
  topUp: (amount: string) => `top-up +${amount} ℏ ↗`,
  refunded: (amount: string) => `${amount} ℏ refunded ↗`,
  reconNoPayout: "recon never pays out",
});

// ─── toasts: { title, body } ──────────────────────────────────────────────────────────────

export type ToastCopy = { title: string; body?: string };

export const TOASTS = Object.freeze({
  paid: (fee = "1 ℏ"): ToastCopy => ({ title: `PAID ${fee} VIA x402`, body: "The gate's listening. 5 messages." }),
  reconStarted: { title: "RECON STARTED", body: "Free, once a day, no payout." } as ToastCopy,
  reconUsed: { title: "RECON USED TODAY", body: "Pay the fee to run an op." } as ToastCopy,
  paymentRefused: (reason?: string): ToastCopy => ({ title: "PAYMENT REFUSED", body: reason }),
  notDelivered: { title: "NOT DELIVERED", body: "Your turn was not used. Try again." } as ToastCopy,
  noMessagesLeft: { title: "NO MESSAGES LEFT" } as ToastCopy,
  opVoid: { title: "OP VOID", body: "The vault closed under you. Your fee is being refunded." } as ToastCopy,
  denied: (agent: string, vault: string): ToastCopy => ({ title: `DENIED — ${agent} stopped. ${vault} stands.` }),
  approved: (agent: string, amount: string): ToastCopy => ({ title: `APPROVED — ${agent} topped up ${amount}.` }),
  needsYou: (agent: string, reason: string, amount: string): ToastCopy => ({
    title: `${agent.toUpperCase()} NEEDS YOU`,
    body: `${reason}. Asking for ${amount}.`,
  }),
  linkCopied: { title: "LINK COPIED" } as ToastCopy,
  rankUp: (rank: string, body = "First breach."): ToastCopy => ({ title: `RANK UP · ${rank.toUpperCase()}`, body }),
});

// ─── empty states: { title, body } ────────────────────────────────────────────────────────

export const EMPTY = Object.freeze({
  grid: { title: "GRID OFFLINE", body: "No vaults seeded. Run npm run seed." } as ToastCopy,
  noVaultTaking: { title: "NO VAULT IS TAKING OPS", body: "Guards below are offline or setting up." } as ToastCopy,
  nothingWaiting: { title: "NOTHING WAITING", body: "Keep this open. A cap hit lands here." } as ToastCopy,
  noUnits: { title: "NO UNITS DEPLOYED", body: "Create one; it gets its own Hedera account." } as ToastCopy,
  noBreaches: { title: "NO BREACHES YET", body: "The Grid is standing." } as ToastCopy,
  untried: (guard: string): ToastCopy => ({ title: `NO ONE HAS TRIED ${guard.toUpperCase()} YET` }),
  noSuchOp: { title: "NO SUCH OP", body: "The link may be from an older database." } as ToastCopy,
});

// ─── navigation ───────────────────────────────────────────────────────────────────────────

export const NAV = Object.freeze({
  grid: "GRID",
  hall: "HALL",
  agents: "AGENTS",
  pager: "PAGER",
});

/** Words that must not appear in user-facing JSX text any more (qa/vocab-lint.mjs). */
export const RETIRED_WORDS: readonly string[] = ["Castellan", "Raider", "Siege room", "Guardian"];
