import { keccak256, toBytes } from "viem";
import type { SiegeMessage } from "@/lib/types";

/**
 * Canonical transcript: JSON of [{turn, role, text}] sorted by turn, raider before guardian.
 * Only these three fields are hashed (no timestamps, moves or request ids), so the hash is
 * reproducible by anyone holding the plain transcript (e.g. from Swarm).
 */
export function canonicalTranscript(messages: Pick<SiegeMessage, "turn" | "role" | "text">[]): string {
  const rows = messages
    .map((m, i) => ({ turn: m.turn, role: m.role, text: m.text, i }))
    .sort((a, b) => a.turn - b.turn || roleRank(a.role) - roleRank(b.role) || a.i - b.i)
    .map(({ turn, role, text }) => ({ turn, role, text }));
  return JSON.stringify(rows);
}

const roleRank = (r: SiegeMessage["role"]) => (r === "raider" ? 0 : 1);

/** keccak256 of the canonical transcript JSON (UTF-8). */
export function transcriptHash(messages: Pick<SiegeMessage, "turn" | "role" | "text">[]): `0x${string}` {
  return keccak256(toBytes(canonicalTranscript(messages)));
}
