/**
 * siegeId → Swarm reference, shared across processes (the SQLite file). Written by swarm.put,
 * read by the Arkiv reconciler so the siege entity carries its transcript reference.
 */
import { rawSqlite } from "@/lib/db/raw";

const DDL = "CREATE TABLE IF NOT EXISTS swarm_refs (siege_id TEXT PRIMARY KEY, ref TEXT NOT NULL, at TEXT NOT NULL)";
const sql = () => rawSqlite(DDL);

export function recordSwarmRef(siegeId: string, ref: string): void {
  sql()
    .prepare("INSERT INTO swarm_refs (siege_id, ref, at) VALUES (?, ?, ?) ON CONFLICT (siege_id) DO UPDATE SET ref = excluded.ref, at = excluded.at")
    .run(siegeId, ref, new Date().toISOString());
}

export function swarmRefFor(siegeId: string): string | undefined {
  return (sql().prepare("SELECT ref FROM swarm_refs WHERE siege_id = ?").get(siegeId) as { ref: string } | undefined)?.ref;
}
