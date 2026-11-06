/**
 * npm run arkiv:wipe — delete every arena-owned entity in the configured namespace and forget the
 * local records, so the next `npm run arkiv` republishes everything from scratch. For demo resets
 * and schema changes. Castellan-owned listings cannot be deleted by the arena; they expire on their
 * own (and are readonly, so a stale one is harmless).
 */
import "@/lib/config/load-env";
import { arenaAddress, arkivReader, arkivWriter } from "@/lib/arkiv/client";
import { arkivConfig, arkivLinks } from "@/lib/arkiv/config";
import { ENTITY_KINDS, schemas } from "@/lib/arkiv/schema";
import { db } from "@/lib/db";

async function main() {
  const c = arkivConfig();
  if (!c.privateKey) throw new Error("Set ARKIV_PRIVATE_KEY in frontend/.env");
  const keys: `0x${string}`[] = [];
  for (const kind of ENTITY_KINDS) {
    const res = await (arkivReader() as unknown as {
      select(s: unknown): { from(s: unknown): { ownedBy(a: string): { limit(n: number): { fetch(): Promise<{ entities: { $key: `0x${string}` }[] }> } } } };
    })
      .select({ $key: true })
      .from(schemas()[kind])
      .ownedBy(arenaAddress())
      .limit(100)
      .fetch();
    console.log(`${c.namespace}.${kind}: ${res.entities.length} arena-owned`);
    keys.push(...res.entities.map((e) => e.$key));
  }
  for (let i = 0; i < keys.length; i += 20) {
    const chunk = keys.slice(i, i + 20);
    const res = await arkivWriter().executeBatch({ deletes: chunk.map((entityKey) => ({ entityKey })) } as never);
    console.log(`deleted ${chunk.length}: ${arkivLinks.tx(res.txHash)}`);
  }
  const sql = (db() as unknown as { $client: { exec(s: string): void } }).$client;
  sql.exec("DROP TABLE IF EXISTS arkiv_entities; DROP TABLE IF EXISTS arkiv_outbox; DROP TABLE IF EXISTS arkiv_meta");
  console.log(`done: ${keys.length} entities deleted, local records cleared`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message.split("\n")[0] : String(e));
    process.exit(1);
  },
);
