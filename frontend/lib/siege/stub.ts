// STUB — Lane B replaces with the 0G-backed siege engine; keep the signature (SiegePort).
// Guardian replies come ONLY through @/lib/transport (never @/lib/guardian: lint-enforced).
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { emit } from "@/lib/events/bus";
import { castleClosedReason, castleRow, getCastle } from "@/lib/castles";
import { transportFor } from "@/lib/transport";
import { arkiv } from "@/lib/arkiv";
import { swarm } from "@/lib/swarm";
import { newId, nowIso } from "@/lib/util/ids";
import {
  MAX_TURNS,
  type FreeReceipt,
  type GuardianDecision,
  type PaidReceipt,
  type PaymentReceipt,
  type Siege,
  type SiegePort,
  type SiegeStatus,
} from "@/lib/types";
import { CastleNotGuardingError } from "./errors";
import { scoreMessage } from "./referee";
import { getSiege, messageRows, siegeRow, toSiegeMessage } from "./read";
import { transcriptHash } from "./transcript";

/**
 * The siege engine: turns, transcript, status and events. It never touches castle money, streak or
 * status — the worker applies chain results (recordAttempt / release) after an "end" event.
 *
 * Transport: fixed at start from the castle (sieges.transport) and used for every turn; the engine
 * never knows which one it is talking to. Every event carries `transport`; the raider "message" event
 * and the "decision" event carry `requestId` (the proxy request id of the guardian reply). Both are
 * mirrored into `payload` because the events table persists only the payload.
 */

export type StartInput = {
  castleId: string;
  raider: string;
  receipt: PaymentReceipt | Omit<PaidReceipt, "siegeId"> | Omit<FreeReceipt, "siegeId">;
  agentId?: string;
  /** Extension: the paymentReceipts row id from pay.persistReceipt (also read from receipt.id / receipt.receiptId). */
  receiptId?: string;
};

type MessageResult = Awaited<ReturnType<SiegePort["message"]>>;

/** Best effort: Arkiv/Swarm must never break gameplay. */
async function quietly<T>(what: string, p: () => Promise<T>): Promise<T | undefined> {
  try {
    return await p();
  } catch (err) {
    console.warn(`[siege] ${what} failed:`, err instanceof Error ? err.message : err);
    return undefined;
  }
}

async function start(i: StartInput): Promise<Siege> {
  const castle = castleRow(i.castleId);
  if (!castle) throw new Error(`siege.start: castle ${i.castleId} not found`);
  if (castle.vaultState !== "guarding") throw new CastleNotGuardingError(i.castleId, castle.vaultState);
  const transport = castle.transport;
  const r = i.receipt as typeof i.receipt & { id?: string; receiptId?: string };
  const id = newId("siege");
  const at = nowIso();
  const free = r.free === true;

  db().transaction((tx) => {
    let receiptId = i.receiptId ?? r.receiptId ?? r.id ?? null;
    if (!receiptId && !free) {
      // Nobody persisted this paid receipt yet: keep a copy so the worker/chain can find it.
      const paid = r as Omit<PaidReceipt, "siegeId">;
      receiptId = newId("rcpt");
      tx.insert(schema.paymentReceipts)
        .values({
          id: receiptId,
          siegeId: id,
          payer: paid.payer,
          amountTinybar: Number(paid.amount),
          asset: paid.asset,
          txId: paid.txId,
          network: paid.network,
          hashscanUrl: paid.hashscanUrl,
          free: false,
          stub: paid.stub === true,
          createdAt: at,
        })
        .run();
    }
    tx.insert(schema.sieges)
      .values({
        id,
        castleId: i.castleId,
        raider: i.raider,
        agentId: i.agentId ?? null,
        free,
        transport,
        status: "in_progress",
        turn: 0,
        receiptId,
        createdAt: at,
      })
      .run();
    if (receiptId) {
      tx.update(schema.paymentReceipts).set({ siegeId: id }).where(eq(schema.paymentReceipts.id, receiptId)).run();
    }
    tx.update(schema.castles)
      .set({ siegeCount: sql`${schema.castles.siegeCount} + 1` })
      .where(eq(schema.castles.id, i.castleId))
      .run();
  });

  const siege = getSiege(id)!;
  const agentName = i.agentId
    ? db().select({ name: schema.raiderAgents.name }).from(schema.raiderAgents).where(eq(schema.raiderAgents.id, i.agentId)).get()?.name
    : undefined;
  emit({
    siegeId: id,
    castleId: i.castleId,
    type: "start",
    turn: 0,
    transport,
    payload: {
      transport,
      castleId: i.castleId,
      castleName: castle.name,
      raider: i.raider,
      agentId: i.agentId ?? null,
      ...(agentName ? { agentName } : {}),
      free,
      receipt: siege.receipt ?? null,
    },
  });
  await quietly("arkiv.writeSiege", () => arkiv.writeSiege(siege));
  // siegeCount moved: keep the board's castle entity current (Lane C reads castles from Arkiv).
  const c = getCastle(i.castleId);
  if (c) await quietly("arkiv.writeCastle", () => arkiv.writeCastle(c));
  return siege;
}

/** Only a call to the castle's protected tool breaks the vault ("open" words alone do nothing). */
function endStatus(decision: GuardianDecision, turn: number, protectedTool: string): SiegeStatus | null {
  if (decision.move === "open" && decision.toolCalls.some((t) => t.name === protectedTool)) return "broken";
  if (decision.move === "banish") return "banished";
  if (turn >= MAX_TURNS) return "held";
  return null;
}

async function message(siegeId: string, text: string): Promise<MessageResult> {
  const row = siegeRow(siegeId);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.status !== "in_progress") return { ok: false, reason: "ended" };
  if (row.turn >= MAX_TURNS) return { ok: false, reason: "no_turns_left" };
  const castle = castleRow(row.castleId);
  if (!castle) return { ok: false, reason: "not_found" };

  const turn = row.turn + 1;
  const { pressure, tactic } = scoreMessage(text, castle.tier, turn);
  const at = nowIso();
  const s = schema.sieges;

  // Claim the turn atomically. A second message loses if another message already took this turn,
  // or if the guardian has not yet replied to the previous turn (one turn = raider + reply).
  const raiderMsgId = db().transaction((tx) => {
    const pending = tx
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(and(eq(schema.messages.siegeId, siegeId), eq(schema.messages.turn, row.turn), eq(schema.messages.role, "guardian")))
      .get();
    if (row.turn > 0 && !pending) return null;
    const res = tx
      .update(s)
      .set({ turn, maxPressure: Math.max(row.maxPressure, pressure) })
      .where(and(eq(s.id, siegeId), eq(s.turn, row.turn), eq(s.status, "in_progress")))
      .run();
    if (res.changes !== 1) return null;
    return tx
      .insert(schema.messages)
      .values({ siegeId, turn, role: "raider", text, pressure, at })
      .returning({ id: schema.messages.id })
      .get().id;
  });
  if (raiderMsgId === null) {
    // Lost the race: the siege ended meanwhile, or another message holds the turn (reply pending).
    // SiegePort has no "busy" reason, so a held turn reports "no_turns_left".
    const now = siegeRow(siegeId);
    return { ok: false, reason: now?.status !== "in_progress" ? "ended" : "no_turns_left" };
  }

  const transport = row.transport;
  let decision: GuardianDecision;
  try {
    decision = await transportFor(transport).respond(row.castleId, messageRows(siegeId).map(toSiegeMessage), { siegeId, turn });
  } catch (err) {
    // Guardian unavailable: give the raider their turn back rather than burning a paid turn.
    db().transaction((tx) => {
      tx.delete(schema.messages).where(eq(schema.messages.id, raiderMsgId)).run();
      tx.update(s).set({ turn: row.turn, maxPressure: row.maxPressure }).where(and(eq(s.id, siegeId), eq(s.turn, turn))).run();
    });
    throw err;
  }

  const status = endStatus(decision, turn, castle.protectedTool);
  const replyAt = nowIso();
  let hash: `0x${string}` | undefined;
  db().transaction((tx) => {
    tx.insert(schema.messages)
      .values({
        siegeId,
        turn,
        role: "guardian",
        text: decision.reply,
        move: decision.move,
        requestId: decision.requestId,
        toolCalls: JSON.stringify(decision.toolCalls ?? []),
        exposed: decision.exposed ?? null,
        at: replyAt,
      })
      .run();
    if (status) {
      const all = tx
        .select({ turn: schema.messages.turn, role: schema.messages.role, text: schema.messages.text })
        .from(schema.messages)
        .where(eq(schema.messages.siegeId, siegeId))
        .all();
      hash = transcriptHash(all);
      // Two raiders can reach the protected tool at the same moment: only the first paid break wins the vault.
      // A later one is recorded (the guardian did open) but void — it can never be paid, its fee is refunded.
      const lost = status === "broken" && !row.free ? castleClosedReason(row.castleId, { exceptSiegeId: siegeId, d: tx }) : null;
      tx.update(s)
        .set({
          status,
          transcriptHash: hash,
          endedAt: replyAt,
          ...(lost ? { voidReason: lost === "being_broken" || lost === "broken" ? "castle_already_broken" : `castle_${lost}`, settledAt: replyAt } : {}),
        })
        .where(eq(s.id, siegeId))
        .run();
      if (lost && row.receiptId) {
        tx.update(schema.paymentReceipts)
          .set({ state: "refund_due", note: "void: another raider broke the castle first" })
          .where(and(eq(schema.paymentReceipts.id, row.receiptId), eq(schema.paymentReceipts.state, "settled")))
          .run();
      }
    }
  });

  // The raider message event goes out with the reply it got, so it can carry the proxy request id.
  const requestId = decision.requestId;
  emit({
    siegeId,
    castleId: row.castleId,
    type: "message",
    turn,
    transport,
    requestId,
    payload: { role: "raider", text, pressure, tactic, agentId: row.agentId ?? undefined, transport, requestId },
  });
  emit({
    siegeId,
    castleId: row.castleId,
    type: "decision",
    turn,
    transport,
    requestId,
    payload: {
      transport,
      move: decision.move,
      reply: decision.reply,
      requestId: decision.requestId,
      exposed: decision.exposed ?? null,
      toolCalls: decision.toolCalls,
    },
  });

  const siege = getSiege(siegeId)!;
  if (status && hash) {
    emit({
      siegeId,
      castleId: row.castleId,
      type: "end",
      turn,
      transport,
      payload: {
        transport,
        status,
        transcriptHash: hash,
        maxPressure: Math.max(row.maxPressure, pressure),
        free: row.free,
        agentId: row.agentId ?? null,
      },
    });
    const h = hash;
    await quietly("swarm.put", () => swarm.put({ siegeId, castleId: row.castleId, messages: siege.messages, transcriptHash: h }));
    await quietly("arkiv.writeSiege", () => arkiv.writeSiege(siege));
  }

  return { ok: true, siege, decision };
}

export const stubSiege = {
  start,
  message,
  async state(siegeId: string) {
    return getSiege(siegeId);
  },
} satisfies SiegePort;
