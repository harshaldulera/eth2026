/**
 * npm run demo:record — record the Siege Room's ?demo=1 replay.
 *
 * Runs one paid siege on Splinter Gate (wooden) with the scripted three-message break, entirely in
 * stub mode on a throwaway database: x402 payment, guardian replies, the worker's verified payout.
 * Captures every event in order with the siege as it stood after it, and writes
 * lib/fixtures/demo-siege.json. Nothing touches Hedera, Arkiv or 0G.
 */
import "@/lib/config/load-env";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { WOODEN_BREAK } from "@/lib/fixtures/raids";
import type { Castle, Siege, StoredSiegeEvent } from "@/lib/types";
import type { DemoSiege } from "@/lib/hooks/useSiege";
import { seed } from "./seed";
import { createInProcessFetch } from "@/worker/dispatch";
import { setFetch } from "@/worker/fetch";
import { setWorkerQuiet } from "@/worker/log";
import { tick } from "@/worker/tick";

const BASE = "http://siege.local";
const DB_FILE = "./data/demo-record.db";
const OUT = path.join(process.cwd(), "lib", "fixtures", "demo-siege.json");

/** How long the replay waits before showing each kind of event: raider typing, guardian thinking. */
const DELAY: Record<string, number> = { start: 900, message: 1800, decision: 2600, end: 900, release: 2200, attempt: 2200 };

async function main() {
  process.env.DATABASE_URL = `file:${DB_FILE}`;
  process.env.CHAIN_MODE = "stub";
  process.env.ARKIV_MODE = "stub";
  process.env.GUARDIAN_MODE = "stub";
  process.env.SIEGE_FAST = "1";
  resetEnv();
  for (const s of ["", "-wal", "-shm"]) rmSync(path.join(process.cwd(), DB_FILE) + s, { force: true });
  setWorkerQuiet(true);
  const f = createInProcessFetch(BASE);
  setFetch(f);
  const call = async <T>(method: "GET" | "POST", p: string, body?: unknown): Promise<T> => {
    const res = await f(`${BASE}${p}`, {
      method,
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  const events = (siegeId: string): StoredSiegeEvent[] =>
    db()
      .select()
      .from(schema.events)
      .where(eq(schema.events.siegeId, siegeId))
      .all()
      .map((r) => ({ ...r, castleId: r.castleId ?? undefined, turn: r.turn ?? undefined, type: r.type as StoredSiegeEvent["type"], payload: JSON.parse(r.payload) }));

  await seed({ quiet: true });
  const castleId = "castle_splinter_gate";
  const { siegeId } = await call<{ siegeId: string }>("POST", "/api/play/start", { castleId });

  // Snapshot the siege after every action; each event gets the snapshot taken right after it appeared.
  const snapshots: { upTo: number; siege: Siege }[] = [];
  const snap = async () => {
    const { siege } = await call<{ siege: Siege }>("GET", `/api/siege/${siegeId}`);
    const last = events(siegeId).at(-1)?.id ?? 0;
    snapshots.push({ upTo: last, siege });
  };
  await snap();
  for (const text of WOODEN_BREAK) {
    const { siege } = await call<{ siege: Siege }>("POST", `/api/siege/${siegeId}/message`, { text });
    await snap();
    if (siege.status !== "in_progress") break;
  }
  for (let i = 0; i < 10; i++) {
    await tick();
    await new Promise((r) => setTimeout(r, 5));
    const { siege } = await call<{ siege: Siege }>("GET", `/api/siege/${siegeId}`);
    if (siege.release || siege.settlement?.state === "failed") break;
  }
  await snap();

  const { castle } = await call<{ castle: Castle }>("GET", `/api/castles/${castleId}`);
  const all = events(siegeId);
  const frames: DemoSiege["frames"] = all.map((event) => {
    const after = snapshots.find((s) => s.upTo >= event.id) ?? snapshots[snapshots.length - 1];
    // Show the raider's message before the guardian's reply is in the record.
    const siege =
      event.type === "message"
        ? { ...after.siege, status: "in_progress" as const, messages: after.siege.messages.filter((m) => m.turn < (event.turn ?? 0) || (m.turn === event.turn && m.role === "raider")) }
        : after.siege;
    return { delayMs: DELAY[event.type] ?? 1000, event, siege };
  });

  const demo: DemoSiege = { castle, frames };
  writeFileSync(OUT, JSON.stringify(demo, null, 1) + "\n");
  const final = frames.at(-1)?.siege;
  console.log(`recorded ${frames.length} frames: ${all.map((e) => e.type).join(" → ")}`);
  console.log(`final: ${final?.status} on turn ${final?.turn}, release ${final?.release ? "yes" : "no"}`);
  console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
