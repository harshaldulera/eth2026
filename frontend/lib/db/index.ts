import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import path from "node:path";
import * as schema from "./schema";
import { env } from "@/lib/config/env";

export type DB = BetterSQLite3Database<typeof schema>;

const g = globalThis as unknown as { __siegeDb?: { db: DB; sqlite: Database.Database; url: string } };

function resolveFile(url: string): string {
  const file = url.replace(/^file:/, "");
  if (file === ":memory:") return file;
  const abs = path.isAbsolute(file) ? file : path.join(/*turbopackIgnore: true*/ process.cwd(), file);
  mkdirSync(path.dirname(abs), { recursive: true });
  return abs;
}

/** "file::memory:" and ":memory:" name the same (process-wide, cached) in-memory database. */
const normalizeUrl = (url: string) => (url.replace(/^file:/, "") === ":memory:" ? ":memory:" : url);

/** Open (or reuse) the SQLite database and apply migrations from ./drizzle. */
export function openDb(rawUrl: string = env().DATABASE_URL): DB {
  const url = normalizeUrl(rawUrl);
  if (g.__siegeDb && g.__siegeDb.url === url) return g.__siegeDb.db;
  const sqlite = new Database(resolveFile(url));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  g.__siegeDb = { db, sqlite, url };
  return db;
}

/** The shared database handle. Next routes, the worker and scripts all use the same file. */
export function db(): DB {
  return openDb();
}

/** Tests: fresh in-memory database. */
export function openTestDb(): DB {
  g.__siegeDb = undefined;
  return openDb(":memory:");
}

export { schema };
export type { ReceiptState } from "./schema";
