/**
 * Keeps Arkiv in step with the server's SQLite copy, whoever changed it (seed, the worker's
 * settlement, vault transitions, sieges). Each pass queues only entities whose public values
 * differ from what Arkiv holds, so an idle arena sends nothing.
 */
import { and, desc, gte, inArray, isNotNull, or } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { toCastle } from "@/lib/castles";
import { toSiege } from "@/lib/siege/read";
import { swarmRefFor } from "@/lib/swarm/refs";
import { enqueue, entityRecord, OP_TTL_MIN } from "./outbox";
import { guardianProfile, raiderProfile } from "./profiles";

const MIN = 60_000;
/** Ended ops stay on Arkiv this long, so the "just ended" row shows before it expires. */
const RECENT_MS = OP_TTL_MIN * MIN;

export type ReconcileResult = { vaults: number; ops: number; profiles: number };

export function reconcile(now = Date.now()): ReconcileResult {
  const out: ReconcileResult = { vaults: 0, ops: 0, profiles: 0 };

  // Castles: all of them (a handful). Expired ones are dropped by the drainer.
  const castleRows = db().select().from(schema.castles).all();
  for (const row of castleRows) {
    // A plugged-in vault published from the web but not yet funded: its owner wallet is only claimed, not
    // proven by a deposit. Listed once the owner's deposit lands (depositTx) or a vault exists on chain.
    if (row.published && row.transport === "sdk" && !row.depositTx && row.vaultId == null) continue;
    if (enqueue({ kind: "vault", data: toCastle(row) }).queued) out.vaults += 1;
  }

  // Sieges: live ones, and ones that ended recently.
  const since = new Date(now - RECENT_MS).toISOString();
  const s = schema.sieges;
  const siegeRows = db()
    .select()
    .from(s)
    .where(or(inArray(s.status, ["created", "in_progress"]), and(isNotNull(s.endedAt), gte(s.endedAt, since))))
    .orderBy(desc(s.createdAt))
    .limit(200)
    .all();
  const raiders = new Set<string>();
  for (const row of siegeRows) {
    const siege = toSiege(row);
    const live = siege.status === "created" || siege.status === "in_progress";
    // A live siege nobody has touched for a while would expire mid-siege: refresh it in time.
    const rec = entityRecord("op", siege.id);
    const force = live && !!rec && rec.expiresAtMs - now < (OP_TTL_MIN / 2) * MIN;
    if (enqueue({ kind: "op", data: siege, swarmRef: swarmRefFor(siege.id) }, { force }).queued) out.ops += 1;
    if (!live) raiders.add(siege.raider);
  }

  // Profiles: every vault Owner, and operators whose ops just ended.
  for (const owner of new Set(castleRows.map((c) => c.owner))) {
    const p = guardianProfile(owner);
    if (p && enqueue({ kind: "guardProfile", data: p }).queued) out.profiles += 1;
  }
  for (const wallet of raiders) {
    const p = raiderProfile(wallet);
    if (p && enqueue({ kind: "operatorProfile", data: p }).queued) out.profiles += 1;
  }
  return out;
}
