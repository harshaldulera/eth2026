// Lane B: the siege engine and verifier behind the frozen SiegePort / VerifierPort signatures.
import type { SiegePort, VerifierPort } from "@/lib/types";
import { stubSiege, type StartInput } from "./stub";
import { zeroGVerifier } from "./verifier";

/** SiegePort; `start` also accepts an optional `receiptId` (row id from pay.persistReceipt). */
export const siege: SiegePort & { start(i: StartInput): ReturnType<SiegePort["start"]> } = stubSiege;
export const verifier: VerifierPort = zeroGVerifier;

export { getSiege, listSieges, localTxRef, siegeRow, settlementFor } from "./read";
export { transcriptHash, canonicalTranscript } from "./transcript";
export { scoreMessage } from "./referee";
export type { StartInput } from "./stub";
