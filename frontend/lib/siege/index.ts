// STUB — Lane B replaces the engine/verifier behind these exports with the 0G-backed ones; keep the signatures.
import type { SiegePort, VerifierPort } from "@/lib/types";
import { stubSiege, type StartInput } from "./stub";
import { stubVerifier } from "./verifier";

/** SiegePort; `start` also accepts an optional `receiptId` (row id from pay.persistReceipt). */
export const siege: SiegePort & { start(i: StartInput): ReturnType<SiegePort["start"]> } = stubSiege;
export const verifier: VerifierPort = stubVerifier;

export { getSiege, listSieges, localTxRef, siegeRow, settlementFor } from "./read";
export { transcriptHash, canonicalTranscript } from "./transcript";
export { scoreMessage } from "./referee";
export type { StartInput } from "./stub";
export { CastleNotGuardingError } from "./errors";
