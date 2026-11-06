// STUB — Lane B replaces with the 0G Compute guardian; keep the signature (export const guardian: GuardianPort, optional proxy key).
// Only lib/transport may import this (eslint no-restricted-imports): the siege engine goes through @/lib/transport.
import { stubGuardian, type StubGuardian } from "./stub";

export const guardian: StubGuardian = stubGuardian;
export type { GuardianVia } from "./stub";
