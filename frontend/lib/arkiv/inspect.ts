/**
 * One castle's Arkiv footprint, for the castle page: both entities with their on-chain owner and
 * expiry. Server only (reads the local key records and the chain).
 */
import { getCastle } from "@/lib/castles";
import { arkivReader } from "./client";
import { castellanWallet, entityRecord, isDelisted } from "./outbox";

type EntityInfo = { key: string; owner?: string; readonly?: boolean; expiresAtMs?: number };
type Full = { $owner?: string; $expiresAt?: bigint; $creationFlags?: { readonly: boolean } };

async function describe(key: `0x${string}`): Promise<EntityInfo | null> {
  try {
    const [e, block] = await Promise.all([arkivReader().getEntity(key) as unknown as Promise<Full>, arkivReader().getBlockNumber()]);
    return {
      key,
      owner: e.$owner,
      readonly: e.$creationFlags?.readonly,
      expiresAtMs: typeof e.$expiresAt === "bigint" ? Date.now() + Number(e.$expiresAt - block) * 2000 : undefined,
    };
  } catch (err) {
    if (/NoEntityFound|not found/i.test(`${(err as Error)?.name} ${(err as Error)?.message}`)) return null;
    throw err;
  }
}

export async function castleOnArkiv(castleId: string) {
  const castle = getCastle(castleId);
  if (!castle) return null;
  const listingRec = entityRecord("castle", castleId);
  const stateRec = entityRecord("castleState", castleId);
  const [listing, state, castellan, block] = await Promise.all([
    listingRec ? describe(listingRec.key) : null,
    stateRec ? describe(stateRec.key) : null,
    castellanWallet(castle),
    arkivReader().getBlockNumber(),
  ]);
  return { listing, state, castellan, delisted: isDelisted(castleId), block: block.toString() };
}
