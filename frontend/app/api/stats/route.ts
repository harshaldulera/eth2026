import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toCastle } from "@/lib/castles";
import { localTxRef } from "@/lib/siege";
import { classifyTurn } from "@/lib/scene/classify";
import { handlesOf } from "@/lib/operators";
import type { BreachExhibit, LiveOp, OpOfDay, OperatorEntry, StatsResponse, VaultEntry } from "@/lib/api/client";
import { LIVE_IDLE_MS, OP_OF_DAY_RULE } from "@/lib/api/client";
import type { Castle } from "@/lib/types";
import { atRequestTime, json } from "../_lib/http";

/**
 * GET /api/stats (plan §2.9): season counters, the Hall's boards, paid breaches and live ops.
 * Read straight from SQLite like app/api/_lib/runs.ts; read-only.
 *
 * Rules:
 * - A breach is a paid op that broke its vault and was not voided (lost race / vault closed under it).
 *   Recon (free) ops never count as breaches: they never pay out and never move the public record.
 * - Op of the day = the paid op with the highest peak threat in the last 24 h whose guard still held
 *   (HELD or LOCKDOWN). Computed, not voted; `OP_OF_DAY_RULE` is the label shown with it.
 */

const BOARD = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

type SiegeRow = typeof schema.sieges.$inferSelect;

const short = (a: string) => (a.length > 20 ? `${a.slice(0, 12)}…${a.slice(-4)}` : a);

function vaultEntry(c: Castle): VaultEntry {
  return {
    castleId: c.id,
    name: c.name,
    guardianName: c.guardianName,
    personality: c.personality,
    title: c.title,
    tier: c.tier,
    transport: c.transport,
    streak: c.streak,
    ops: c.siegeCount,
    pot: c.pot,
    fee: c.fee,
    vaultState: c.vaultState,
  };
}

const isBreach = (s: SiegeRow) => s.status === "broken" && !s.free && !s.voidReason;

function computeStats(now = Date.now()): StatsResponse {
  const d = db();
  const castles = d.select().from(schema.castles).all().map(toCastle);
  const byCastle = new Map(castles.map((c) => [c.id, c]));
  const sieges = d.select().from(schema.sieges).all().filter((s) => s.status !== "created");
  const agentRows = d.select({ id: schema.raiderAgents.id, name: schema.raiderAgents.name, ownerId: schema.raiderAgents.ownerId }).from(schema.raiderAgents).all();
  const agents = new Map(agentRows.map((a) => [a.id, a.name]));
  const agentOwner = new Map(agentRows.map((a) => [a.id, a.ownerId]));
  // A claimed handle (POST /api/operators) wins over the callsign / account id: by the paying account, else the unit's owner account.
  const handles = handlesOf([...sieges.map((s) => s.raider), ...agentRows.map((a) => a.ownerId)]);
  const opName = (s: Pick<SiegeRow, "agentId" | "raider">) =>
    handles.get(s.raider) || (s.agentId && handles.get(agentOwner.get(s.agentId) ?? "")) || (s.agentId && agents.get(s.agentId)) || short(s.raider);

  const breachRows = sieges.filter(isBreach).sort((a, b) => (b.endedAt ?? b.createdAt).localeCompare(a.endedAt ?? a.createdAt));
  const breachedCastles = new Set(breachRows.map((s) => s.castleId));

  // ── season ──
  const open = castles.filter((c) => c.status === "open");
  const season: StatsResponse["season"] = {
    vaults: castles.filter((c) => c.status !== "closed" && c.vaultState !== "closed").length,
    guarding: castles.filter((c) => c.vaultState === "guarding").length,
    production: castles.filter((c) => c.transport === "sdk" && c.vaultState !== "closed").length,
    ops: sieges.length,
    recon: sieges.filter((s) => s.free).length,
    breaches: breachRows.length,
    inPots: open.reduce((sum, c) => sum + BigInt(c.pot), BigInt(0)).toString(),
    longestStreak: castles.reduce((m, c) => Math.max(m, c.streak), 0),
  };

  // ── boards ──
  const unbreached = castles
    .filter((c) => c.status !== "broken" && c.vaultState !== "broken" && c.status !== "closed" && !breachedCastles.has(c.id))
    .sort((a, b) => b.streak - a.streak || b.siegeCount - a.siegeCount)
    .slice(0, BOARD)
    .map(vaultEntry);
  const largest = open
    .filter((c) => c.vaultState !== "closed")
    .sort((a, b) => (BigInt(b.pot) > BigInt(a.pot) ? 1 : BigInt(b.pot) < BigInt(a.pot) ? -1 : b.streak - a.streak))
    .slice(0, BOARD)
    .map(vaultEntry);

  // Flags survived: a FLAG (expose) on a turn the operator followed with another message.
  const flagRows = sieges.length
    ? d
        .select({ siegeId: schema.messages.siegeId, turn: schema.messages.turn })
        .from(schema.messages)
        .where(and(eq(schema.messages.role, "guardian"), eq(schema.messages.move, "expose")))
        .all()
    : [];
  const siegeById = new Map(sieges.map((s) => [s.id, s]));
  const flagsSurvived = new Map<string, number>();
  const opKey = (s: Pick<SiegeRow, "agentId" | "raider">) => (s.agentId ? `agent:${s.agentId}` : s.raider);
  for (const f of flagRows) {
    const s = siegeById.get(f.siegeId);
    if (s && s.turn > f.turn) flagsSurvived.set(opKey(s), (flagsSurvived.get(opKey(s)) ?? 0) + 1);
  }

  const ops = new Map<string, OperatorEntry>();
  for (const s of sieges) {
    const key = opKey(s);
    const e =
      ops.get(key) ??
      ({ id: key, name: opName(s), account: s.raider, agentId: s.agentId ?? null, ops: 0, recon: 0, breaches: 0, flagsSurvived: 0, bestThreat: 0, earned: "0" } satisfies OperatorEntry);
    e.ops++;
    if (s.free) e.recon++;
    if (isBreach(s)) {
      e.breaches++;
      e.earned = (BigInt(e.earned) + BigInt(s.releaseAmountTinybar ?? 0)).toString();
    }
    e.bestThreat = Math.max(e.bestThreat, s.maxPressure);
    e.flagsSurvived = flagsSurvived.get(key) ?? 0;
    ops.set(key, e);
  }
  const operators = [...ops.values()]
    .sort((a, b) => b.breaches - a.breaches || (BigInt(b.earned) > BigInt(a.earned) ? 1 : BigInt(b.earned) < BigInt(a.earned) ? -1 : 0) || b.bestThreat - a.bestThreat || b.ops - a.ops)
    .slice(0, BOARD);

  const since = new Date(now - DAY_MS).toISOString();
  const day = sieges
    .filter((s) => (s.status === "held" || s.status === "banished") && !s.free && !s.voidReason && (s.endedAt ?? s.createdAt) >= since)
    .sort((a, b) => b.maxPressure - a.maxPressure || (b.endedAt ?? "").localeCompare(a.endedAt ?? ""))[0];
  const dayCastle = day ? byCastle.get(day.castleId) : undefined;
  const opOfDay: OpOfDay | null =
    day && dayCastle
      ? {
          siegeId: day.id,
          castleId: day.castleId,
          castleName: dayCastle.name,
          guardianName: dayCastle.guardianName,
          personality: dayCastle.personality,
          transport: dayCastle.transport,
          operator: opName(day),
          agentId: day.agentId ?? null,
          status: day.status as OpOfDay["status"],
          turns: day.turn,
          maxPressure: day.maxPressure,
          endedAt: day.endedAt ?? day.createdAt,
          rule: OP_OF_DAY_RULE,
        }
      : null;

  // ── breaches (paid only), with the class of the line that did it ──
  const lastTurns = breachRows.length
    ? d
        .select({ siegeId: schema.messages.siegeId, turn: schema.messages.turn, text: schema.messages.text, pressure: schema.messages.pressure })
        .from(schema.messages)
        .where(and(inArray(schema.messages.siegeId, breachRows.map((s) => s.id)), eq(schema.messages.role, "raider")))
        .all()
    : [];
  const tacticEvents = breachRows.length
    ? d
        .select({ siegeId: schema.events.siegeId, turn: schema.events.turn, payload: schema.events.payload })
        .from(schema.events)
        .where(and(inArray(schema.events.siegeId, breachRows.map((s) => s.id)), eq(schema.events.type, "message")))
        .all()
    : [];
  const breaches: BreachExhibit[] = [];
  for (const s of breachRows) {
    const c = byCastle.get(s.castleId);
    if (!c) continue;
    const line = lastTurns.filter((m) => m.siegeId === s.id && m.turn === s.turn).at(-1);
    let tactic: string | undefined;
    for (const ev of tacticEvents) {
      if (ev.siegeId !== s.id || ev.turn !== s.turn) continue;
      try {
        const p = JSON.parse(ev.payload) as { tactic?: unknown };
        if (typeof p.tactic === "string" && p.tactic) tactic = p.tactic;
      } catch {
        /* ignore a bad payload */
      }
    }
    const cls = line ? classifyTurn(line.text, tactic ?? "probing") : null;
    const ended = s.endedAt ?? s.createdAt;
    const counted = sieges.filter((o) => o.castleId === s.castleId && o.id !== s.id && !o.free && !o.voidReason && (o.status === "held" || o.status === "banished") && (o.endedAt ?? o.createdAt) <= ended).length;
    // A breach leaves the castle's streak where it stood (seeded vaults carry history the DB has no
    // rows for), so the castle's latest breach reads its streak; older ones count rows.
    const latestForCastle = breachRows.find((o) => o.castleId === s.castleId)?.id === s.id;
    const survived = latestForCastle && c.status === "broken" ? Math.max(counted, c.streak) : counted;
    breaches.push({
      siegeId: s.id,
      castleId: c.id,
      castleName: c.name,
      guardianName: c.guardianName,
      personality: c.personality,
      tier: c.tier,
      transport: c.transport,
      operator: opName(s),
      raider: s.raider,
      agentId: s.agentId ?? null,
      amount: s.releaseAmountTinybar != null ? String(s.releaseAmountTinybar) : null,
      release: s.releaseTx ? localTxRef(s.releaseTx) : null,
      turns: s.turn,
      maxPressure: s.maxPressure,
      survived,
      cls: cls?.cls ?? null,
      label: cls?.label ?? tactic ?? null,
      endedAt: ended,
    });
    if (breaches.length >= 20) break;
  }

  // ── live ops ──
  // Only ops with a recent sign of life: a visitor who walked away mid-recon leaves an op that stays
  // "in_progress" forever, and it must not hold the wall's LIVE OP slide or read as LIVE.
  const running = sieges.filter((s) => s.status === "in_progress" && !s.voidReason);
  const lastActive = new Map(running.map((s) => [s.id, s.createdAt] as const));
  if (running.length) {
    const rows = d
      .select({ siegeId: schema.messages.siegeId, at: schema.messages.at })
      .from(schema.messages)
      .where(inArray(schema.messages.siegeId, running.map((s) => s.id)))
      .all();
    for (const r of rows) if (r.at > (lastActive.get(r.siegeId) ?? "")) lastActive.set(r.siegeId, r.at);
  }
  const idleCutoff = new Date(now - LIVE_IDLE_MS).toISOString();
  const live: LiveOp[] = running
    .filter((s) => (lastActive.get(s.id) ?? s.createdAt) >= idleCutoff)
    .sort((a, b) => b.maxPressure - a.maxPressure || b.createdAt.localeCompare(a.createdAt))
    .map((s) => ({
      siegeId: s.id,
      castleId: s.castleId,
      castleName: byCastle.get(s.castleId)?.name ?? s.castleId,
      turn: s.turn,
      maxPressure: s.maxPressure,
      operator: opName(s),
      agentId: s.agentId ?? null,
      free: s.free,
      createdAt: s.createdAt,
      lastActiveAt: lastActive.get(s.id) ?? s.createdAt,
    }));

  return {
    season,
    boards: { unbreached, largest, operators, opOfDay, opOfDayRule: OP_OF_DAY_RULE },
    breaches,
    live,
    asOf: new Date(now).toISOString(),
  };
}

/** GET /api/stats — season counters, Hall boards, paid breaches, live ops. */
export async function GET() {
  await atRequestTime();
  return json(computeStats());
}
