/**
 * What GET /api/replay/[id] returns: a finished siege, turn by turn, with every piece of evidence a
 * stranger can check. Browser-safe (types only).
 */
import type { Castle, GuardianMove, Siege, Verification } from "@/lib/types";

export type CheckState = "pass" | "fail" | "pending" | "na";

/** One line of the proof checklist at the top of the page. */
export type ReplayCheck = { key: string; label: string; state: CheckState; detail: string; href?: string };

/** An audit message for this siege on the castle's HCS topic. */
export type HcsEntry = {
  type: string;
  /** HCS sequence number once on the topic; null while queued. */
  seq: number | null;
  state: "pending" | "submitted";
  /** Hash the message carries (message hash for siege.message, transcript hash for siege.end/vault.*). */
  hash?: string;
  requestId?: string;
  txId?: string;
  /** Mirror-node check of this exact message on the public topic (testnet only). */
  mirror: "confirmed" | "mismatch" | "missing" | "unchecked";
};

export type ReplayTurn = {
  turn: number;
  raider?: {
    text: string;
    /** keccak256 of the message's UTF-8 bytes, as the audit log commits it. */
    hash: `0x${string}`;
    hcs?: HcsEntry;
    /** The HCS hash equals the hash of the text shown here. */
    matches: boolean | null;
  };
  guardian?: {
    text: string;
    move?: GuardianMove;
    requestId?: string;
    toolCalls: string[];
    /** A call to the castle's protected tool: the break. */
    calledProtectedTool: boolean;
    /** The inference record behind this reply (hashes only, never content). */
    record?: { provider: string; model: string; protectedToolCalled: boolean; mock: boolean; at: string };
    /** Replies from a test guardian (the stub, or the SDK test harness) have no inference record. */
    stub: boolean;
  };
};

export type ReplayData = {
  siege: Omit<Siege, "messages">;
  castle: Castle;
  transcript: {
    /** Where the transcript shown here was read from. */
    source: "swarm" | "swarm-stub" | "database";
    ref?: string;
    recomputedHash: `0x${string}`;
    storedHash?: string;
    /** The transcript's recomputed hash equals the siege's stored hash. */
    matches: boolean | null;
  };
  turns: ReplayTurn[];
  hcs: {
    topicId: string | null;
    topicUrl?: string;
    /** Stub topics live only in this server's database. */
    stub: boolean;
    entries: HcsEntry[];
    /** The siege.end message's transcript hash. */
    endHash?: string;
    mirror: "checked" | "unavailable" | "skipped";
  };
  verdict: (Verification & { applicable: boolean }) | null;
  checks: ReplayCheck[];
  /** Voided: the castle closed or another raider won first; the fee is refunded. */
  voided: boolean;
  /** The siege can still change (not ended, or waiting for its chain result). */
  live: boolean;
};
