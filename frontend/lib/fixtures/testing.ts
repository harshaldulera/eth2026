import { db, openTestDb, schema } from "@/lib/db";
import { resetEnv } from "@/lib/config/env";
import { fixtureCastleRows } from "./castles";

/**
 * Tests: a fresh in-memory DB with the five fixture castles. Points DATABASE_URL at the same
 * ":memory:" url openTestDb uses, so db() (used by the bus, castles, siege…) returns this handle.
 */
export function freshFixtureDb() {
  process.env.DATABASE_URL = ":memory:";
  resetEnv();
  const handle = openTestDb();
  db().insert(schema.castles).values(fixtureCastleRows()).run();
  return handle;
}
