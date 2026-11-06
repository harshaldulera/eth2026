/**
 * Builds the replay of one siege: the transcript (from Swarm when we have the reference), every hash
 * recomputed here, compared with what the siege stored and what the HCS topic carries, and the
 * inference record behind each guardian reply. Server only.
 *
 * Hashes and audit messages are recomputed and compared on every load. The payout and refund come
 * from the arena's own records (with HashScan links), cross-checked against the audit log.
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
import { reasonText, refundText, verifyText } from "@/lib/siege/text";
import { transcriptHash } from "@/lib/siege/transcript";
import { REFERENCE_RE, sealedCopy, swarm, swarmLinks, swarmPending, swarmWorkerAlive, type SealedState } from "@/lib/swarm";
import { swarmRefFor } from "@/lib/swarm/refs";
import type { SiegeMessage } from "@/lib/types";
import type { HcsEntry, ReplayCheck, ReplayData, ReplayTurn } from "./types";

/** An op outcome in the game's words (the code says broken / banished). */
const OUTCOME_WORD: Record<string, string> = { broken: "breached", banished: "lockdown", held: "held", in_progress: "live", created: "not started" };
const outcomeWord = (s?: string) => (s ? (OUTCOME_WORD[s] ?? s.replace(/_/g, " ")) : "nothing");

const ENDED = new Set(["held", "broken", "banished"]);
const short = (h?: string | null) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "");

/** The "transcript on Swarm" line of the checklist. Pure, so every wording is testable without a gateway. */
export function transcriptCheck(i: { ref?: string; source: ReplayData["transcript"]["source"]; ended: boolean; sealed: SealedState; refUrl?: string; workerAlive?: boolean }): ReplayCheck {
  const { ref, source, ended, sealed, refUrl, workerAlive } = i;
  const LABEL: Record<ReplayData["transcript"]["source"], string> = {
    swarm: "Transcript read from Swarm",
    "swarm-copy": "Transcript read from the sealed copy kept for Swarm",
    "swarm-stub": "Transcript read from the Swarm store (local stand-in)",
    database: "Transcript read from the arena database",
  };
  return {
    key: "transcript",
    label: LABEL[source],
    state: ref ? (source === "database" ? "fail" : source === "swarm-copy" ? (workerAlive ? "pending" : "fail") : "pass") : sealed === "pending" || !ended ? "pending" : "na",
    detail: ref
      ? `reference ${short(ref.replace(/^swarm-stub:/, ""))}${
          source === "database"
            ? ", but the transcript could not be read from it"
            : source === "swarm-copy"
              ? workerAlive
                ? ", Swarm did not answer for it; the worker is putting the sealed copy back"
                : ", Swarm did not answer for it, and no worker is running to put the sealed copy back"
              : ""
        }`
      : sealed === "pending"
        ? "sealed, upload to Swarm pending (the worker retries it)"
        : sealed === "stranded"
          ? "sealed for Swarm but never uploaded, and no worker is running to retry it"
          : ended
            ? "no Swarm reference recorded for this op"
            : "uploaded when the op ends",
    ...(refUrl && source === "swarm" ? { href: refUrl } : {}),
  };
}
/** Replies with no model call behind them: the stub guardian, and the SDK transport's test harness. */
const STUB_REPLY = /^(0g|sdk)-stub-/;
/** A voided siege's refund normally lands within minutes; after this the page stops waiting for it. */
const REFUND_WAIT_MS = 30 * 60_000;
/**
 * How long a submitted message may be absent from the mirror node before it counts as missing. Real
 * mirror lag is seconds; past this the topic was reset or the message never landed, and waiting
 * longer would only poll forever.
 */
const MIRROR_LAG_MS = 10 * 60_000;
/** How long after an op ends the page keeps re-reading an unreachable mirror node. */
const MIRROR_RETRY_MS = 30 * 60_000;

/** The audit messages for this siege, in topic order, and how many were skipped (no topic). */
function auditRows(siegeId: string) {
  const A = schema.auditLog;
  const all = db().select().from(A).where(eq(A.siegeId, siegeId)).orderBy(asc(A.id)).all();
  return { rows: all.filter((r) => r.state !== "skipped"), skipped: all.filter((r) => r.state === "skipped").length };
}

const isRealTopic = (t: string | null | undefined): t is string => Boolean(t) && !isStubRef(t) && !t!.includes("stub") && t !== "none";

export type MirrorRead = { seen: Map<number, string>; absent: Set<number>; failed: Set<number> };

/**
 * One topic's messages from the mirror node, fetched one by one by sequence number (a topic is shared
 * by every siege on the castle, so a range or "newest N" read can miss them). `absent`: answered 404.
 * `failed`: no answer we can trust (network error, 5xx, 429, malformed or misnumbered body).
 */
export async function mirrorMessages(topicId: string, seqs: number[]): Promise<MirrorRead> {
  const base = env().HEDERA_MIRROR_URL.replace(/\/$/, "");
  const out: MirrorRead = { seen: new Map(), absent: new Set(), failed: new Set() };
  await Promise.all(
    [...new Set(seqs)].map(async (seq) => {
      try {
        const res = await fetch(`${base}/api/v1/topics/${encodeURIComponent(topicId)}/messages/${seq}`, {
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: AbortSignal.timeout(10_000),
        });
        if (res.status === 404) return void out.absent.add(seq);
        if (!res.ok) return void out.failed.add(seq);
        const body = (await res.json()) as { message?: unknown; sequence_number?: unknown };
        if (typeof body.message !== "string" || body.sequence_number !== seq) return void out.failed.add(seq);
        out.seen.set(seq, Buffer.from(body.message, "base64").toString("utf8"));
      } catch {
        out.failed.add(seq);
      }
    }),
  );
  return out;
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
  const now = Date.now();

  // ── Transcript: Swarm first, the database only when there is no reference ─────────────────────
  const ref = swarmRefFor(siegeId);
  let messages: SiegeMessage[] = dbMessages;
  let source: ReplayData["transcript"]["source"] = "database";
  if (ref) {
    const t = await swarm.get(ref).catch(() => null);
    if (t?.messages?.length) {
      messages = t.messages;
      source = ref.startsWith("swarm-stub:") ? "swarm-stub" : "swarm";
    } else if (REFERENCE_RE.test(ref)) {
      // Swarm has nothing for the reference right now (gateway down, or its stamp lapsed): show the
      // sealed copy kept here and have the worker put it back.
      const copy = sealedCopy(siegeId, now);
      if (copy?.messages?.length) {
        messages = copy.messages;
        source = "swarm-copy";
      }
    }
  }
  /** A live reference is openable on the gateway (the bytes are the sealed envelope, not the text). */
  const refUrl = ref && REFERENCE_RE.test(ref) ? swarmLinks.bytes(ref) : undefined;
  /** Sealed at siege end but never landed: a worker is retrying it, or nothing is. */
  const sealed = ref ? null : swarmPending(siegeId, now);
  const workerAlive = swarmWorkerAlive(now);
  const recomputedHash = transcriptHash(messages);
  const storedHash = siege.transcriptHash;
  const transcriptMatches = storedHash ? storedHash.toLowerCase() === recomputedHash.toLowerCase() : null;

  // ── HCS: what the topic(s) carry for this siege ────────────────────────────────────────────────
  const { rows, skipped } = auditRows(siegeId);
  // The topic this siege was audited on: its own rows carry it. The castle's topic can have moved
  // since (seed --new-topics at the freeze); old sequence numbers mean nothing on the new one.
  const topicId = rows[0]?.topicId ?? castle.topicId ?? null;
  // Not audited: every row was skipped (no topic when it ran), or testnet with no topic at all.
  const noTopic = rows.length === 0 && (skipped > 0 || (!castle.topicId && env().CHAIN_MODE === "testnet"));
  const stubTopic = !noTopic && !isRealTopic(topicId);
  const realTopic = !stubTopic && !noTopic;

  // Each row is read back from the topic it was written to (a siege can straddle a rotation).
  const byTopic = new Map<string, number[]>();
  for (const r of rows) if (r.state === "submitted" && r.seq != null && isRealTopic(r.topicId)) byTopic.set(r.topicId, [...(byTopic.get(r.topicId) ?? []), r.seq]);
  // The page keeps re-reading the mirror only while the op is live, or recently ended, or an audit
  // message was submitted recently (the outbox can submit long after the op ended).
  const lastActivity = Math.max(
    Date.parse(siege.endedAt ?? siege.createdAt) || 0,
    ...rows.map((r) => Date.parse(r.submittedAt ?? r.at) || 0),
  );
  const retrying = !ended || now - lastActivity < MIRROR_RETRY_MS;
  const reads = new Map<string, MirrorRead>();
  if (env().CHAIN_MODE === "testnet") await Promise.all([...byTopic].map(async ([t, seqs]) => reads.set(t, await mirrorMessages(t, seqs))));
  const asked = [...byTopic.values()].reduce((n, s) => n + new Set(s).size, 0);
  const failedReads = [...reads.values()].reduce((n, r) => n + r.failed.size, 0);
  const mirror: ReplayData["hcs"]["mirror"] = !reads.size ? "skipped" : failedReads === 0 ? "checked" : failedReads === asked ? "unavailable" : "partial";
  /** The highest sequence number the mirror answered for, per topic: it indexes in order. */
  const highestSeen = new Map([...reads].map(([t, r]) => [t, Math.max(-1, ...r.seen.keys())]));

  let mirrorBehind = false;
  const entries: HcsEntry[] = rows.map((r) => {
    const p = parse(r.message);
    const submitted = r.state === "submitted";
    let m: HcsEntry["mirror"] = "unchecked";
    const read = reads.get(r.topicId);
    if (read && submitted && r.seq != null) {
      const seen = read.seen.get(r.seq);
      if (seen !== undefined) m = seen === r.message ? "confirmed" : "mismatch";
      else if (read.absent.has(r.seq)) {
        // Sequence numbers have no gaps: if the mirror already has a later message on this topic,
        // this one is really missing. If not, the mirror may just be behind, but only for a while:
        // only this op's own messages are read, so a lost last message would otherwise wait forever.
        const age = now - Date.parse(r.submittedAt ?? r.at);
        if ((highestSeen.get(r.topicId) ?? -1) > r.seq || !(age < MIRROR_LAG_MS)) m = "missing";
        else mirrorBehind = true;
      }
    }
    return {
      type: r.type,
      seq: submitted ? r.seq : null,
      state: submitted ? "submitted" : "pending",
      topicId: r.topicId,
      hash: str(p.hash),
      requestId: str(p.requestId),
      txId: str(p.txId) ?? r.txId ?? undefined,
      result: str(p.result),
      turn: typeof p.turn === "number" ? p.turn : undefined,
      mirror: m,
    };
  });
  const byTurn = new Map<number, HcsEntry>();
  for (const e of entries) if (e.type === "siege.message" && e.turn !== undefined) byTurn.set(e.turn, e);
  const end = entries.find((e) => e.type === "siege.end");
  const onTopicBad = (e?: HcsEntry) => e?.mirror === "mismatch" || e?.mirror === "missing";

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
    const hcs = byTurn.get(turn);
    const out: ReplayTurn = { turn };
    if (r) {
      const hash = keccak256(stringToBytes(r.text));
      const local = hcs?.hash ? hcs.hash.toLowerCase() === hash.toLowerCase() : null;
      const issue: NonNullable<ReplayTurn["raider"]>["issue"] =
        local === false ? "hash" : hcs?.mirror === "mismatch" ? "mirror-mismatch" : hcs?.mirror === "missing" ? "mirror-missing" : undefined;
      out.raider = { text: r.text, hash, hcs, matches: issue ? false : local, ...(issue ? { issue } : {}) };
    }
    if (g) {
      const toolCalls = toolCallsFor(turn);
      const rec = g.requestId ? proxy.record(g.requestId) : null;
      // The record must be for this castle, siege and turn, and the request id must be the one the
      // audit log committed for this turn.
      const recordIssue = !rec
        ? undefined
        : rec.castleId !== castle.id
          ? "belongs to another vault"
          : // As strict as the verifier (lib/siege/verifier.ts): an untagged record fails too, or the
            // replay would pass a record the verifier refuses to pay on.
            rec.siegeId !== siegeId || rec.turn !== turn
            ? "is not tagged with this op and turn"
            : undefined;
      const auditIssue = hcs?.requestId && g.requestId && hcs.requestId !== g.requestId ? "differs from the request id in the audit log" : undefined;
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
        ...(recordIssue || auditIssue ? { issue: recordIssue ?? auditIssue } : {}),
      };
    }
    return out;
  });

  // ── Verifier: only a paid break is ever paid out, so only that verdict matters ─────────────────
  const applicable = siege.status === "broken" && !siege.free && !voided;
  const verdict = ENDED.has(siege.status) ? { ...(await verifier.verify(siegeId)), applicable } : null;

  // ── The checklist ──────────────────────────────────────────────────────────────────────────────
  const checks: ReplayCheck[] = [];
  checks.push(transcriptCheck({ ref, source, ended, sealed, refUrl, workerAlive }));
  checks.push({
    key: "hash",
    label: "Transcript hash recomputed here matches the op's",
    state: transcriptMatches === null ? (ended && !voided ? "fail" : ended ? "na" : "pending") : transcriptMatches ? "pass" : "fail",
    detail: transcriptMatches === null ? (voided ? "voided before it ended, no transcript hash" : "no hash stored yet") : `${short(recomputedHash)}${transcriptMatches ? "" : ` vs stored ${short(storedHash)}`}`,
  });

  // siege.end: same transcript hash AND the same outcome as the siege record says.
  const endHashOk = end?.hash ? end.hash.toLowerCase() === recomputedHash.toLowerCase() : null;
  const endResultOk = end?.result ? end.result === siege.status : null;
  const endReadFailed = Boolean(end?.seq != null && end.topicId && reads.get(end.topicId)?.failed.has(end.seq));
  checks.push({
    key: "hcs-end",
    label: noTopic ? "Hash on an HCS topic" : stubTopic ? "Same hash and outcome in the audit log (stub topic, this server only)" : "Same hash and outcome on the HCS topic",
    state: noTopic
      ? "na"
      : !end
        ? ended && !voided ? "pending" : "na"
        : endHashOk === false || endResultOk === false || onTopicBad(end)
          ? "fail"
          : end.state === "pending" || (realTopic && end.mirror !== "confirmed")
            ? "pending"
            : "pass",
    detail: noTopic
      ? "not audited: this vault had no HCS topic"
      : !end
        ? voided ? "voided before it ended" : "siege.end not in the audit log yet"
        : endHashOk === false
          ? `the audit log's transcript hash ${short(end.hash)} differs from the one recomputed here`
          : endResultOk === false
          ? `the audit log says ${outcomeWord(end.result)}, the op record says ${outcomeWord(siege.status)}`
          : `siege.end${end.seq != null ? ` #${end.seq}` : " (queued)"}${
              end.mirror === "confirmed"
                ? ", confirmed on the mirror node"
                : end.mirror === "missing"
                  ? ", not on the topic"
                  : end.mirror === "mismatch"
                    ? ", the topic carries different bytes"
                    : realTopic && end.state === "submitted"
                      ? endReadFailed || mirror === "unavailable" ? `, mirror node unreachable${retrying ? ", retrying" : ""}` : ", waiting for the mirror node"
                      : ""
            }`,
    href: realTopic && end?.topicId ? topicUrl(end.topicId) : realTopic && topicId ? topicUrl(topicId) : undefined,
  });

  // Raider messages: every transcript turn against the audit log, and no audited turn missing from the transcript.
  const raiderTurns = turns.filter((t) => t.raider);
  const msgOk = raiderTurns.filter((t) => t.raider!.matches === true).length;
  const transcriptTurns = new Set(raiderTurns.map((t) => t.turn));
  const lostTurns = [...byTurn.keys()].filter((t) => !transcriptTurns.has(t)).sort((a, b) => a - b);
  checks.push({
    key: "hcs-messages",
    label: "Every operator message matches its hash in the audit log",
    state: noTopic || (!raiderTurns.length && !lostTurns.length) ? "na" : lostTurns.length || raiderTurns.some((t) => t.raider!.matches === false) ? "fail" : msgOk === raiderTurns.length ? "pass" : "pending",
    detail: noTopic
      ? "not audited: this vault had no HCS topic"
      : lostTurns.length
        ? `the audit log has turn ${lostTurns.join(", ")}, the transcript does not`
        : `${msgOk} of ${raiderTurns.length}`,
  });

  // Every audit row for this siege on the public topic, byte for byte (testnet only).
  if (realTopic) {
    const bad = entries.filter(onTopicBad);
    const unchecked = entries.filter((e) => e.state === "pending" || e.mirror === "unchecked");
    checks.push({
      key: "hcs-all",
      label: "Every audit message is on the topic exactly as recorded",
      state: bad.length ? "fail" : unchecked.length ? "pending" : entries.length ? "pass" : "na",
      detail: bad.length
        ? `${bad.map((e) => `${e.type}${e.seq != null ? ` #${e.seq}` : ""} ${e.mirror === "missing" ? "missing" : "differs"}`).join("; ")}`
        : `${entries.length - unchecked.length} of ${entries.length} confirmed${
            mirror === "unavailable" || mirror === "partial"
              ? `, mirror node unreachable for some${retrying ? ", retrying" : ""}`
              : unchecked.length && unchecked.every((e) => e.state === "pending")
                ? ", the rest still queued in the arena's outbox"
                : unchecked.length
                  ? ", waiting for the mirror node"
                  : ""
          }`,
      href: topicId ? topicUrl(topicId) : undefined,
    });
  }

  const replies = turns.filter((t) => t.guardian);
  const proven = replies.filter((t) => (t.guardian!.record || t.guardian!.stub) && !t.guardian!.issue).length;
  const replyIssue = replies.find((t) => t.guardian!.issue);
  checks.push({
    key: "inference",
    label: replies.length && replies.every((t) => t.guardian!.stub) ? "Every reply came from a test guard (no model call)" : "Every guard reply has its own inference record",
    state: !replies.length ? "na" : proven === replies.length ? "pass" : "fail",
    detail: replyIssue
      ? `turn ${replyIssue.turn}: the model record ${replyIssue.guardian!.issue}`
      : `${proven} of ${replies.length}${replies.some((t) => t.guardian!.record?.mock) ? ", some from the offline test model" : ""}`,
  });

  if (siege.status === "broken") {
    // The verifier reads today's settings (guardian mode, mock policy). A break already paid out under
    // the settings of its time is not re-failed by a later config change.
    const configDrift = Boolean(verdict && !verdict.ok && siege.release && /^(stub_reply_while_0g|mock_response)$/.test(verdict.reason ?? ""));
    checks.push({
      key: "verifier",
      label: "Verifier confirms the breach",
      state: !verdict ? "pending" : verdict.ok ? "pass" : applicable && !configDrift ? "fail" : "na",
      detail: !verdict
        ? ""
        : verdict.ok
          ? `protected tool ${castle.protectedTool} called, request ${short(verdict.requestId)}${voided ? `; not paid: ${reasonText(siege.settlement?.reason, "public")}` : ""}`
          : configDrift
            ? `paid out under the guard settings of the time; today the verifier would say ${verifyText(verdict.reason)}`
            : voided
              ? `not paid: ${reasonText(siege.settlement?.reason, "public")}`
              : verifyText(verdict.reason),
    });
  }

  if (!siege.free && ended) {
    const tx = siege.status === "broken" ? siege.release : siege.attempt;
    const refund = siege.settlement?.refund;
    // The payout tx the siege records must be the one the audit log committed.
    const auditTx = entries.find((e) => e.type === (siege.status === "broken" ? "vault.release" : "siege.attempt"))?.txId;
    const txMismatch = Boolean(!voided && tx && auditTx && auditTx !== tx.txId);
    checks.push({
      key: "payout",
      label: voided ? "Fee refunded (op voided)" : siege.status === "broken" ? "Vault paid out on Hedera" : "Fee split recorded on Hedera",
      state: voided
        ? refund?.state === "refunded" ? "pass" : refund?.state === "failed" ? "fail" : "pending"
        : txMismatch ? "fail" : tx ? "pass" : siege.settlement?.state === "failed" ? "fail" : "pending",
      detail: voided
        ? `${reasonText(siege.settlement?.reason, "public", { ended: siege.status === "held" || siege.status === "banished" })}; ${refundText(siege)}`
        : txMismatch
          ? `the op records ${tx!.txId}, the audit log ${auditTx}`
          : tx
            ? tx.stub ? "stub transaction (no network)" : tx.txId
            : siege.settlement?.state === "failed"
              ? `the worker gave up: ${reasonText(siege.settlement.reason, "public")}`
              : "waiting for the worker",
      href: voided ? (refund?.tx && !refund.tx.stub ? refund.tx.hashscanUrl : undefined) : tx && !tx.stub ? tx.hashscanUrl || txUrl(tx.txId) : undefined,
    });
  }

  const awaitingChain = !siege.free && ended && !voided && !(siege.status === "broken" ? siege.release : siege.attempt) && siege.settlement?.state !== "failed";
  const refundDue = voided && !siege.free && (siege.settlement?.refund?.state ?? "due") === "due" && now - Date.parse(siege.endedAt ?? siege.createdAt) < REFUND_WAIT_MS;
  return {
    siege: siegeMeta,
    castle,
    transcript: { source, ref, url: refUrl, recomputedHash, storedHash, matches: transcriptMatches },
    turns,
    hcs: { topicId: noTopic ? null : topicId, topicUrl: realTopic && topicId ? topicUrl(topicId) : undefined, stub: stubTopic, noTopic, entries, endHash: end?.hash, mirror, retrying },
    verdict,
    checks,
    voided,
    // Keep polling while anything can still change: the siege, its chain result, a refund, the audit
    // outbox, a mirror node that is behind, or reads that failed and should be retried.
    // A row called missing keeps the page re-reading for a while too: a stalled mirror that catches
    // up turns it back to confirmed without a reload.
    live:
      !ended ||
      awaitingChain ||
      refundDue ||
      mirrorBehind ||
      ((failedReads > 0 || entries.some((e) => e.mirror === "missing")) && retrying) ||
      entries.some((e) => e.state === "pending"),
  };
}
