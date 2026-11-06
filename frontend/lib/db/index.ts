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

/**
 * 0003 migrations that existed before the lane-a/lane-b merge and were replaced by
 * 0003_byoa_vault_state_proxy (drizzle journal `when`): main's 0003_vault_state_transport and lane-b's
 * 0003_proxy_records. A DB that applied one of them cannot take the merged 0003 (drizzle would re-run
 * it on top and fail on "table proxy_records already exists").
 */
// main's 0003_vault_state_transport is kept as-is (DBs migrated from main upgrade in place via 0004).
// lane-b/checkpoint-0 shipped a different 0003 that main never had; drizzle would skip main's 0003 on such a DB.
const SUPERSEDED_0003 = new Map<number, string>([
  [1793949796859, "0003_proxy_records (lane-b/checkpoint-0, before the merge)"],
]);

/** Refuse, with instructions, a DB migrated by a superseded 0003 instead of crashing mid-migration. */
export function assertNoSupersededMigration(sqlite: Database.Database, label: string): void {
  const has = sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get();
  if (!has) return;
  const rows = sqlite.prepare("SELECT created_at AS at FROM __drizzle_migrations").all() as { at: number | string }[];
  const old = rows.map((r) => SUPERSEDED_0003.get(Number(r.at))).find(Boolean);
  if (!old) return;
  throw new Error(
    `${label} was migrated with ${old}, which main's migration history never had (main's 0003_vault_state_transport + 0004_lane_b_proxy_records replace it); it cannot be upgraded in place. ` +
      "Local stub DB: run `npm run db:reset`. Testnet DB: back the file up first — it holds the castle -> on-chain vault mapping " +
      "and any refund_due receipts — then reset and re-seed (or migrate it by hand).",
  );
}

/** Open (or reuse) the SQLite database and apply migrations from ./drizzle. */
export function openDb(rawUrl: string = env().DATABASE_URL): DB {
  const url = normalizeUrl(rawUrl);
  if (g.__siegeDb && g.__siegeDb.url === url) return g.__siegeDb.db;
  const sqlite = new Database(resolveFile(url));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  try {
    assertNoSupersededMigration(sqlite, url);
  } catch (e) {
    sqlite.close();
    throw e;
  }
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
