import { db } from "@/lib/db";

/** The better-sqlite3 handle behind db(). */
export type RawSqlite = { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } };

const ready = new WeakMap<object, Set<string>>();

/**
 * The raw handle, with `ddl` run once per handle. For tables a module owns next to the app's
 * (Lane C's Swarm and Arkiv bookkeeping), created here so Lane A's migrations stay untouched.
 */
export function rawSqlite(ddl: string): RawSqlite {
  const s = (db() as unknown as { $client: RawSqlite }).$client;
  let done = ready.get(s);
  if (!done) ready.set(s, (done = new Set()));
  if (!done.has(ddl)) {
    s.exec(ddl);
    done.add(ddl);
  }
  return s;
}
