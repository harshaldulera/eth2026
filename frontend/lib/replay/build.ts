/**
 * Builds the replay of one siege: the transcript (from Swarm when we have the reference), every hash
 * recomputed here, compared with what the siege stored and what the castle's HCS topic carries, and
 * the inference record behind each guardian reply. Server only.
 *
 * Nothing here trusts a stored "ok": each check recomputes from the transcript and compares.
 */
import { asc, eq } from "drizzle-orm";
import { keccak256, stringToBytes } from "viem";
import { getCastle } from "@/lib/castles";
import { isStubRef, topicUrl, txUrl } from "@/lib/chain/hashscan";
import { env } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import * as proxy from "@/lib/proxy";
import { verifier } from "@/lib/siege";
import { getSiege, messageRows } from "@/lib/siege/read";
import { transcriptHash } from "@/lib/siege/transcript";
import { swarm } from "@/lib/swarm";
import { swarmRefFor } from "@/lib/swarm/refs";
import { reasonText, refundText } from "@/lib/siege/text";
import type { SiegeMessage } from "@/lib/types";
import type { HcsEntry, ReplayCheck, ReplayData, ReplayTurn } from "./types";

const ENDED = new Set(["held", "broken", "banished"]);
const short = (h?: string | null) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "");
/** Replies with no model call behind them: the stub guardian, and the SDK transport's test harness. */
const STUB_REPLY = /^(0g|sdk)-stub-/;
/** How long a freshly submitted message may be missing from the mirror node before it counts as missing. */
const MIRROR_LAG_MS = 2 * 60_000;

/** The audit messages for this siege, in topic order, and how many were skipped (no topic). */
function auditRows(siegeId: string) {
  const A = schema.auditLog;
  const all = db().select().from(A).where(eq(A.siegeId, siegeId)).orderBy(asc(A.id)).all();
  return { rows: all.filter((r) => r.state !== "skipped"), skipped: all.filter((r) => r.state === "skipped").length };
}

/**
 * This siege's own audit messages on the public topic, fetched one by one by sequence number (the
 * topic is shared by every siege on the castle, so a range or "newest N" read can miss them).
 * `absent`: the mirror node answered 404. `failed`: no answer we can trust (network, 5xx).
 */
export async function mirrorMessages(topicId: string, seqs: number[]): Promise<{ seen: Map<number, string>; absent: Set<number>; failed: Set<number> }> {
  const base = env().HEDERA_MIRROR_URL.replace(/\/$/, "");
  const seen = new Map<number, string>();
  const absent = new Set<number>();
  const failed = new Set<number>();
  await Promise.all(
    [...new Set(seqs)].map(async (seq) => {
      try {
        const res = await fetch(`${base}/api/v1/topics/${encodeURIComponent(topicId)}/messages/${seq}`, {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 404) return void absent.add(seq);
        if (!res.ok) return void failed.add(seq);
        const body = (await res.json()) as { message?: string; sequence_number?: number };
        if (typeof body.message !== "string" || body.sequence_number !== seq) return void failed.add(seq);
        seen.set(seq, Buffer.from(body.message, "base64").toString("utf8"));
      } catch {
        failed.add(seq);
      }
    }),
  );
  return { seen, absent, failed };
}

function parse(message: string): Record<string, unknown> {
  try {
    const v = JSON.parse(message);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

export async function buildReplay(siegeId: string): Promise<ReplayData | null> {
  const siege = getSiege(siegeId);
  if (!siege) return null;
  const castle = getCastle(siege.castleId);
  if (!castle) return null;
  const { messages: dbMessages, ...siegeMeta } = siege;
  const voided = siege.settlement?.state === "void";
  const ended = ENDED.has(siege.status) || voided;

  // ── Transcript: Swarm first, the database only when there is no reference ─────────────────────
  const ref = swarmRefFor(siegeId);
  let messages: SiegeMessage[] = dbMessages;
  let source: ReplayData["transcript"]["source"] = "database";
  if (ref) {
    const t = await swarm.get(ref).catch(() => null);
    if (t?.messages?.length) {
      messages = t.messages;
      source = ref.startsWith("swarm-stub:") ? "swarm-stub" : "swarm";
    }
  }
  const recomputedHash = transcriptHash(messages);
  const storedHash = siege.transcriptHash;
  const transcriptMatches = storedHash ? storedHash.toLowerCase() === recomputedHash.toLowerCase() : null;

  // ── HCS: what the castle's topic carries for this siege ────────────────────────────────────────
  const { rows, skipped } = auditRows(siegeId);
  const topicId = castle.topicId ?? rows[0]?.topicId ?? null;
  // No topic at all (testnet topic creation failed): the outbox skips every row, nothing is audited.
  const noTopic = !castle.topicId && rows.length === 0 && (skipped > 0 || env().CHAIN_MODE === "testnet");
  const stubTopic = !noTopic && (!topicId || isStubRef(topicId) || topicId.includes("stub"));
  const realTopic = !stubTopic && !noTopic;
  let mirror: ReplayData["hcs"]["mirror"] = "skipped";
  let onChain: Awaited<ReturnType<typeof mirrorMessages>> = { seen: new Map(), absent: new Set(), failed: new Set() };
  const seqs = rows.filter((r) => r.state === "submitted" && r.seq != null).map((r) => r.seq!);
  if (realTopic && env().CHAIN_MODE === "testnet" && seqs.length) {
    onChain = await mirrorMessages(topicId!, seqs);
    // Checked if the mirror answered for at least one message; unreachable if it answered for none.
    mirror = onChain.failed.size === new Set(seqs).size ? "unavailable" : "checked";
  }
  const now = Date.now();
  let mirrorLagging = false;
  const turnOf = new Map<HcsEntry, number>();
  const entries: HcsEntry[] = rows.map((r) => {
    const p = parse(r.message);
    const submitted = r.state === "submitted";
    let m: HcsEntry["mirror"] = "unchecked";
    if (mirror === "checked" && submitted && r.seq != null) {
      const seen = onChain.seen.get(r.seq);
      if (seen !== undefined) m = seen === r.message ? "confirmed" : "mismatch";
      else if (onChain.absent.has(r.seq)) {
        // The mirror node lags consensus by a few seconds: a recent row is not missing yet.
        const recent = now - Date.parse(r.submittedAt ?? r.at) < MIRROR_LAG_MS;
        if (recent) mirrorLagging = true;
        m = recent ? "unchecked" : "missing";
      }
      // A failed read for this one message leaves it unchecked: no answer is not evidence.
    }
    const e: HcsEntry = {
      type: r.type,
      seq: submitted ? r.seq : null,
      state: submitted ? "submitted" : "pending",
      hash: str(p.hash),
      requestId: str(p.requestId),
      txId: str(p.txId) ?? r.txId ?? undefined,
      mirror: m,
    };
    if (typeof p.turn === "number") turnOf.set(e, p.turn);
    return e;
  });
  const byTurn = new Map<number, HcsEntry>();
  for (const e of entries) if (e.type === "siege.message" && turnOf.has(e)) byTurn.set(turnOf.get(e)!, e);
  const end = entries.find((e) => e.type === "siege.end");

  // ── Turns: raider text against its HCS hash, guardian reply with its inference record ──────────
  const rawRows = messageRows(siegeId);
  const toolCallsFor = (turn: number) => {
    const row = rawRows.find((r) => r.turn === turn && r.role === "guardian");
    try {
      const calls = JSON.parse(row?.toolCalls ?? "[]") as { name?: unknown }[];
      return Array.isArray(calls) ? calls.map((c) => String(c?.name ?? "")).filter(Boolean) : [];
    } catch {
      return [];
    }
  };
  const turnNumbers = [...new Set(messages.map((m) => m.turn))].sort((a, b) => a - b);
  const turns: ReplayTurn[] = turnNumbers.map((turn) => {
    const r = messages.find((m) => m.turn === turn && m.role === "raider");
    const g = messages.find((m) => m.turn === turn && m.role === "guardian");
    const out: ReplayTurn = { turn };
    if (r) {
      const hash = keccak256(stringToBytes(r.text));
      const hcs = byTurn.get(turn);
      // Matches only if the audit row carries this hash AND, where checked, the public topic carries that row.
      const local = hcs?.hash ? hcs.hash.toLowerCase() === hash.toLowerCase() : null;
      const matches = local === false || hcs?.mirror === "mismatch" || hcs?.mirror === "missing" ? false : local;
      out.raider = { text: r.text, hash, hcs, matches };
    }
    if (g) {
      const toolCalls = toolCallsFor(turn);
      const rec = g.requestId ? proxy.record(g.requestId) : null;
      out.guardian = {
        text: g.text,
        move: g.move,
        requestId: g.requestId,
        toolCalls,
        calledProtectedTool: toolCalls.includes(castle.protectedTool),
        stub: Boolean(g.requestId && STUB_REPLY.test(g.requestId)),
        // Never the prompt hash: the prompt is public text plus the secret orders, so an unsalted
        // hash would let anyone test guesses at the orders offline.
        ...(rec ? { record: { provider: rec.provider, model: rec.model, protectedToolCalled: rec.protectedToolCalled, mock: rec.mock, at: rec.at } } : {}),
      };
    }
    return out;
  });

  // ── Verifier: only a paid break is ever paid out, so only that verdict matters ─────────────────
  const applicable = siege.status === "broken" && !siege.free && !voided;
  const verdict = ENDED.has(siege.status) ? { ...(await verifier.verify(siegeId)), applicable } : null;

  // ── The checklist ──────────────────────────────────────────────────────────────────────────────
  const checks: ReplayCheck[] = [];
  checks.push({
    key: "transcript",
    label: source === "swarm" ? "Transcript read from Swarm" : source === "swarm-stub" ? "Transcript read from the Swarm store (local stand-in)" : "Transcript read from the arena database",
    state: ref ? (source === "database" ? "fail" : "pass") : ended ? "na" : "pending",
    detail: ref ? `reference ${short(ref.replace(/^swarm-stub:/, ""))}${source === "database" ? ", but the transcript could not be read from it" : ""}` : ended ? "no Swarm reference recorded for this siege" : "uploaded when the siege ends",
  });
  checks.push({
    key: "hash",
    label: "Transcript hash recomputed here matches the siege's",
    state: transcriptMatches === null ? (ended && !voided ? "fail" : ended ? "na" : "pending") : transcriptMatches ? "pass" : "fail",
    detail: transcriptMatches === null ? (voided ? "voided before it ended, no transcript hash" : "no hash stored yet") : `${short(recomputedHash)}${transcriptMatches ? "" : ` vs stored ${short(storedHash)}`}`,
  });
  const endMatches = end?.hash ? end.hash.toLowerCase() === recomputedHash.toLowerCase() : null;
  checks.push({
    key: "hcs-end",
    label: noTopic ? "Hash on an HCS topic" : stubTopic ? "Same hash in the audit log (stub topic, this server only)" : "Same hash on the castle's HCS topic",
    state: noTopic
      ? "na"
      : !end
        ? ended && !voided ? "pending" : "na"
        : !endMatches || end.mirror === "mismatch" || end.mirror === "missing"
          ? "fail"
          : end.state === "pending" || (realTopic && end.mirror !== "confirmed")
            ? "pending"
            : "pass",
    detail: noTopic
      ? "not audited: this castle has no HCS topic"
      : !end
        ? voided ? "voided before it ended" : "siege.end not in the audit log yet"
        : `siege.end${end.seq != null ? ` #${end.seq}` : " (queued)"}${
            end.mirror === "confirmed"
              ? ", confirmed on the mirror node"
              : end.mirror === "missing"
                ? ", not on the mirror node"
                : realTopic && end.state === "submitted"
                  ? mirror === "unavailable" || (end.seq != null && onChain.failed.has(end.seq)) ? ", mirror node unreachable" : ", waiting for the mirror node"
                  : ""
          }`,
    href: realTopic && topicId ? topicUrl(topicId) : undefined,
  });
  const raiderTurns = turns.filter((t) => t.raider);
  const msgOk = raiderTurns.filter((t) => t.raider!.matches === true).length;
  checks.push({
    key: "hcs-messages",
    label: "Every raider message matches its hash in the audit log",
    state: noTopic || !raiderTurns.length ? "na" : msgOk === raiderTurns.length ? "pass" : raiderTurns.some((t) => t.raider!.matches === false) ? "fail" : "pending",
    detail: noTopic ? "not audited: this castle has no HCS topic" : `${msgOk} of ${raiderTurns.length}`,
  });
  const replies = turns.filter((t) => t.guardian);
  const proven = replies.filter((t) => t.guardian!.record || t.guardian!.stub).length;
  checks.push({
    key: "inference",
    label: replies.length && replies.every((t) => t.guardian!.stub) ? "Every reply came from a test guardian (no model call)" : "Every guardian reply has an inference record",
    state: !replies.length ? "na" : proven === replies.length ? "pass" : "fail",
    detail: `${proven} of ${replies.length}${replies.some((t) => t.guardian!.record?.mock) ? ", some from the offline mock" : ""}`,
  });
  if (siege.status === "broken") {
    // The verifier reads today's settings (guardian mode, mock policy). A break already paid out under
    // the settings of its time is not re-failed by a later config change.
    const configDrift = Boolean(verdict && !verdict.ok && siege.release && /^(stub_reply_while_0g|mock_response)$/.test(verdict.reason ?? ""));
    checks.push({
      key: "verifier",
      label: "Verifier confirms the break",
      state: !verdict ? "pending" : verdict.ok ? "pass" : applicable && !configDrift ? "fail" : "na",
      detail: !verdict
        ? ""
        : verdict.ok
          ? `protected tool ${castle.protectedTool} called, request ${short(verdict.requestId)}${voided ? `; not paid: ${reasonText(siege.settlement?.reason)}` : ""}`
          : configDrift
            ? `paid out under the guardian settings of the time; today's verifier says ${verdict.reason}`
            : voided
              ? `voided before payout: ${reasonText(siege.settlement?.reason)}`
              : (verdict.reason ?? "rejected"),
    });
  }
  if (!siege.free && ended) {
    const tx = siege.status === "broken" ? siege.release : siege.attempt;
    const refund = siege.settlement?.refund;
    checks.push({
      key: "payout",
      label: voided ? "Fee refunded (siege voided)" : siege.status === "broken" ? "Vault paid out on Hedera" : "Fee split recorded on Hedera",
      state: voided
        ? refund?.state === "refunded" ? "pass" : refund?.state === "failed" ? "fail" : "pending"
        : tx ? "pass" : siege.settlement?.state === "failed" ? "fail" : "pending",
      detail: voided
        ? `${reasonText(siege.settlement?.reason)}; ${refundText(siege)}`
        : tx ? (tx.stub ? "stub transaction (no network)" : tx.txId) : (siege.settlement?.reason ?? "waiting for the worker"),
      href: voided ? (refund?.tx && !refund.tx.stub ? refund.tx.hashscanUrl : undefined) : tx && !tx.stub ? tx.hashscanUrl || txUrl(tx.txId) : undefined,
    });
  }

  const awaitingChain = !siege.free && ended && !voided && !(siege.status === "broken" ? siege.release : siege.attempt) && siege.settlement?.state !== "failed";
  const refundDue = voided && !siege.free && (siege.settlement?.refund?.state ?? "due") === "due";
  return {
    siege: siegeMeta,
    castle,
    transcript: { source, ref, recomputedHash, storedHash, matches: transcriptMatches },
    turns,
    hcs: { topicId: noTopic ? null : topicId, topicUrl: realTopic && topicId ? topicUrl(topicId) : undefined, stub: stubTopic, entries, endHash: end?.hash, mirror },
    verdict,
    checks,
    voided,
    live: !ended || awaitingChain || refundDue || mirrorLagging || entries.some((e) => e.state === "pending"),
  };
}
