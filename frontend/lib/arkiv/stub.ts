/**
 * Stub-mode pieces kept for tests and offline dev (ARKIV_MODE=stub, the default): writes are
 * remembered in memory under "arkiv-stub:…" keys. The live path is lib/arkiv/outbox.ts.
 */
import type { Castle } from "@/lib/types";

/**
 * The castle entity's shape (plan C1): the fields the board filters on, plus the public Castle.
 * Never includes orders (Castle has none). Expires at the vault deadline.
 */
export type CastleEntity = {
  key: string;
  owner: string;
  expiresAt: number;
  annotations: {
    tier: Castle["tier"];
    status: Castle["status"];
    vaultState: Castle["vaultState"];
    transport: Castle["transport"];
    protectedTool: string;
    pot: string;
    fee: string;
    streak: number;
  };
  payload: Castle;
};

export function castleEntity(castle: Castle): CastleEntity {
  return {
    key: `arkiv-stub:vault:${castle.id}`,
    owner: castle.owner,
    expiresAt: castle.deadline,
    annotations: {
      tier: castle.tier,
      status: castle.status,
      vaultState: castle.vaultState,
      transport: castle.transport,
      protectedTool: castle.protectedTool,
      pot: castle.pot,
      fee: castle.fee,
      streak: castle.streak,
    },
    payload: castle,
  };
}

const g = globalThis as unknown as { __arkivStub?: Map<string, unknown> };
export const stubWrites = (g.__arkivStub ??= new Map<string, unknown>());

/** What the stub was last asked to write (tests / debug). */
export function arkivStubWrites(): ReadonlyMap<string, unknown> {
  return stubWrites;
}
