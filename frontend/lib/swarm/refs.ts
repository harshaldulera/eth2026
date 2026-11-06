/**
 * siegeId → Swarm reference, shared across processes (the SQLite file). Written by swarm.put,
 * read by the Arkiv reconciler so the siege entity carries its transcript reference.
 */
import { db } from "@/lib/db";

type Sqlite = { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown } };
const ready = new WeakSet<object>();

function sql(): Sqlite {
  const s = (db() as unknown as { $client: Sqlite }).$client;
  if (!ready.has(s)) {
    s.exec("CREATE TABLE IF NOT EXISTS swarm_refs (siege_id TEXT PRIMARY KEY, ref TEXT NOT NULL, at TEXT NOT NULL)");
    ready.add(s);
  }
  return s;
}

export function recordSwarmRef(siegeId: string, ref: string): void {
  sql()
    .prepare("INSERT INTO swarm_refs (siege_id, ref, at) VALUES (?, ?, ?) ON CONFLICT (siege_id) DO UPDATE SET ref = excluded.ref, at = excluded.at")
    .run(siegeId, ref, new Date().toISOString());
}

export function swarmRefFor(siegeId: string): string | undefined {
  return (sql().prepare("SELECT ref FROM swarm_refs WHERE siege_id = ?").get(siegeId) as { ref: string } | undefined)?.ref;
}
