/**
 * Wipe and re-seed THE database the app uses:  npm run db:reset
 * Respects DATABASE_URL (default file:./data/siege.db), removes its -wal/-shm files too, then seeds.
 * To re-run a demo on one castle without wiping everything: npm run seed -- --rearm wooden
 */
import "@/lib/config/load-env";
import { existsSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { env } from "@/lib/config/env";

async function main() {
  const url = env().DATABASE_URL;
  const file = url.replace(/^file:/, "");
  if (file === ":memory:") {
    console.log("DATABASE_URL is in-memory: nothing to delete.");
  } else {
    const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
    // Never delete anything that isn't a database file (a bad DATABASE_URL must not point rm at a folder).
    if (!file.trim() || (existsSync(abs) && !statSync(abs).isFile())) {
      throw new Error(`DATABASE_URL must name a database file, got "${url}" (${abs}). Nothing was deleted.`);
    }
    for (const suffix of ["", "-wal", "-shm"]) rmSync(abs + suffix, { force: true });
    console.log(`Deleted ${abs}`);
  }
  // Import after the delete so the DB handle opens a fresh file.
  const { seed } = await import("./seed");
  await seed();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("✗ db:reset failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
