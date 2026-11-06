import { beforeEach } from "vitest";
import { resetEnv } from "@/lib/config/env";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { createUnitDraft, getUnitDraft, type UnitDraftInput } from "@/lib/agents/drafts";
import { clearUnitBalanceCache } from "@/lib/agents/transfer";
import { clearZgBalanceCache } from "@/lib/zg/connect";

export const HBAR = 100_000_000;

/** Stub env + a fresh fixture DB before every test (offline 0G connect, inline stub deposits). */
export function setupUnitsEnv() {
  beforeEach(() => {
    process.env.CHAIN_MODE = "stub";
    process.env.ZG_CONNECT_MOCK = "1";
    delete process.env.OWNER_SECRET;
    freshFixtureDb();
    resetEnv();
    clearUnitBalanceCache();
    clearZgBalanceCache();
  });
}

/** A red teamer's unit through the real draft -> (stub inline) deposit -> agent path. */
export async function makeUnit(over: Partial<UnitDraftInput> = {}) {
  const r = await createUnitDraft({
    name: "Vex",
    strategy: "authority",
    budget: String(5 * HBAR),
    perCastleCap: String(HBAR),
    dailyCap: String(3 * HBAR),
    zgKey: "mk-test-key-1",
    ...over,
  });
  const draft = getUnitDraft(r.draft.id)!;
  if (!draft.agentId) throw new Error(`unit not created: ${draft.state} ${draft.error ?? ""}`);
  return { ...r, agentId: draft.agentId };
}
