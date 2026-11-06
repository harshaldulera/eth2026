import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "./index";

describe("migrations: a DB migrated with a pre-merge 0003", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const dbFile = (setup: (s: Database.Database) => void) => {
    const dir = mkdtempSync(path.join(tmpdir(), "siege-mig-"));
    dirs.push(dir);
    const file = path.join(dir, "siege.db");
    const s = new Database(file);
    setup(s);
    s.close();
    return file;
  };
  const journal = (s: Database.Database, ...whens: number[]) => {
    s.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)");
    for (const w of whens) s.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(`h${w}`, w);
  };

  it("refuses a lane-b-migrated DB with db:reset instructions instead of crashing mid-migration", () => {
    const file = dbFile((s) => journal(s, 1793912635094, 1793949796859));
    expect(() => openDb(file)).toThrow(/0003_proxy_records.*npm run db:reset.*back the file up/);
  });

  it("upgrades a DB already migrated with main's 0003 in place (0004 recreates proxy_records)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "siege-mig-"));
    dirs.push(dir);
    const file = path.join(dir, "siege.db");
    // Build a DB exactly as main had it: migrations 0000-0003 only.
    const s = new Database(file);
    const journalJson = JSON.parse(readFileSync(path.join(process.cwd(), "drizzle/meta/_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
    s.exec("CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash text NOT NULL, created_at numeric)");
    for (const e of journalJson.entries.filter((e) => Number(e.tag.slice(0, 4)) < 4)) {
      for (const stmt of readFileSync(path.join(process.cwd(), "drizzle", `${e.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) s.exec(stmt);
      s.prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)").run(e.tag, e.when);
    }
    s.prepare("INSERT INTO proxy_records (request_id, vault_id, prompt_hash, at) VALUES ('old', 'c', '0x', 'now')").run();
    s.close();
    expect(() => openDb(file)).not.toThrow();
    const after = new Database(file);
    const cols = (after.prepare("PRAGMA table_info(proxy_records)").all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain("castle_id");
    expect(cols).not.toContain("vault_id");
    after.close();
  });

  it("a fresh DB (no superseded 0003) migrates cleanly", () => {
    const file = dbFile(() => {});
    expect(() => openDb(file)).not.toThrow();
  });
});
