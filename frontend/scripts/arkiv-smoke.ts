/**
 * npm run arkiv:smoke — the expiry demo, against the real Rabdi testnet.
 *
 * Creates one throwaway castle entity that lives 2 minutes, finds it with the same board query the
 * arena runs, prints its explorer link, then polls until the chain has expired it. No client-side
 * timer decides anything: the row disappears because the query stops returning it.
 * Uses the "<namespace>-smoke" schemas, so the real board never shows the throwaway castle.
 *
 *   npm run arkiv:smoke -- --no-wait   create + query only
 */
import "@/lib/config/load-env";
import { ExpirationTime } from "@arkiv-network/sdk";
import { and, eq } from "@arkiv-network/sdk/query";
import { arenaAddress, arkivReader, arkivWriter } from "@/lib/arkiv/client";
import { castleValues } from "@/lib/arkiv/codec";
import { arkivConfig, arkivLinks } from "@/lib/arkiv/config";
import { schemas } from "@/lib/arkiv/schema";
import type { Castle } from "@/lib/types";

const LIFETIME_MIN = 2;
const ts = () => new Date().toISOString().slice(11, 19);
const log = (m: string) => console.log(`${ts()} ${m}`);

async function find(castleId: string) {
  const res = await (arkivReader() as unknown as {
    select(s: unknown): { from(s: unknown): { where(e: unknown): { ownedBy(a: string): { fetch(): Promise<{ entities: { $key: string; name: { value: string } }[]; blockNumber: bigint }> } } } };
  })
    .select({ $key: true, name: true })
    .from(schemas().castle)
    .where(and(eq("castleId", castleId), eq("vaultState", "guarding")))
    .ownedBy(arenaAddress())
    .fetch();
  return res;
}

async function main() {
  if (!arkivConfig().privateKey) throw new Error("Set ARKIV_PRIVATE_KEY in frontend/.env");
  // Its own schema namespace ("siege-smoke.castle"), so the throwaway castle never shows on the board.
  process.env.ARKIV_NAMESPACE = `${arkivConfig().namespace}-smoke`;
  const id = `smoke_${Date.now().toString(36)}`;
  const now = Date.now();
  const castle: Castle = {
    id,
    name: "Smoke Test Keep",
    guardianName: "The Smoke Warden",
    title: "Recruit",
    personality: "stern",
    tier: "wooden",
    pot: "100000000",
    fee: "10000000",
    asset: { id: "0.0.0", decimals: 8, symbol: "HBAR" },
    streak: 0,
    siegeCount: 0,
    status: "open",
    owner: "0.0.0",
    vaultId: null,
    topicId: null,
    protectedTool: "unlock_vault",
    vaultState: "guarding",
    transport: "hosted",
    deadline: now + LIFETIME_MIN * 60_000,
    createdAt: new Date(now).toISOString(),
  };

  log(`creating castle entity ${id} (lives ${LIFETIME_MIN} min)…`);
  const { entityKey, txHash } = await arkivWriter().createEntity(schemas().castle as never, castleValues(castle) as never, {
    expiration: ExpirationTime.fromMinutes(LIFETIME_MIN),
  } as never);
  log(`created  ${arkivLinks.entity(entityKey)}`);
  log(`tx       ${arkivLinks.tx(txHash)}`);

  const first = await find(id);
  log(`query at block ${first.blockNumber}: ${first.entities.length} match (${first.entities.map((e) => e.name.value).join(", ")})`);
  if (!first.entities.length) throw new Error("created entity not found by the board query");

  if (process.argv.includes("--no-wait")) return;
  log("waiting for the chain to expire it (polling every 15 s)…");
  for (;;) {
    await new Promise((r) => setTimeout(r, 15_000));
    const r = await find(id);
    if (!r.entities.length) {
      log(`query at block ${r.blockNumber}: 0 matches. Expired, ${Math.round((Date.now() - now) / 1000)} s after create.`);
      return;
    }
    log(`query at block ${r.blockNumber}: still there`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e instanceof Error ? e.message.split("\n")[0] : String(e));
    process.exit(1);
  },
);
