/**
 * Whose 0G credits pay for a model call (plan siege-onboarding-plan.md §0 "0G connectivity").
 *
 *   castle with zg_api_key        → { kind: "user", userId: "castle:<id>", apiKey }
 *   unit with zg_api_key          → { kind: "user", userId: "agent:<id>", apiKey }
 *   fixture castle / arena unit   → { kind: "team" } (the arena key)
 *   published guard / onboarding castle / operator-funded unit WITHOUT a key → ZgNotConnectedError
 *
 * There is no silent fallback to the arena key for anything a user published or funded.
 * Pure (no DB, no fetch): callers pass the row they already loaded.
 */
import type { schema } from "@/lib/db";
import type { Billing } from "@/lib/proxy";

type CastleRow = typeof schema.castles.$inferSelect;
type AgentRow = typeof schema.raiderAgents.$inferSelect;

/** The subset of a castles row billing needs. */
export type CastleBillingRow = Pick<CastleRow, "id" | "zgApiKey"> & Partial<Pick<CastleRow, "published" | "ownerKeyHash">>;
/** The subset of a raider_agents row billing needs (`fundedBy` tells it apart from a castle row). */
export type AgentBillingRow = Pick<AgentRow, "id" | "zgApiKey" | "fundedBy">;
export type BillingRow = CastleBillingRow | AgentBillingRow;

export class ZgNotConnectedError extends Error {
  readonly code = "zg_not_connected";
  constructor(public readonly billedTo: string) {
    super(`${billedTo} has no 0G key connected; its compute never falls back to the arena key`);
    this.name = "ZgNotConnectedError";
  }
}

export const isAgentRow = (row: BillingRow): row is AgentBillingRow => "fundedBy" in row && row.fundedBy !== undefined;

/** "castle:<id>" | "agent:<id>": the proxy_records.billed_to value for this row's own key. */
export function billedToOf(row: BillingRow): string {
  return isAgentRow(row) ? `agent:${row.id}` : `castle:${row.id}`;
}

/**
 * Must this row's compute be paid by its owner? Published guards and any castle created through
 * onboarding (it carries an owner key hash), and every unit its operator funded.
 */
export function needsUserBilling(row: BillingRow): boolean {
  if (isAgentRow(row)) return row.fundedBy === "operator";
  return Boolean(row.published) || Boolean(row.ownerKeyHash);
}

/** User billing for this row's own 0G key. Throws ZgNotConnectedError when it has none. */
export function requireUserBilling(row: BillingRow): Extract<Billing, { kind: "user" }> {
  const apiKey = row.zgApiKey?.trim();
  if (!apiKey) throw new ZgNotConnectedError(billedToOf(row));
  return { kind: "user", userId: billedToOf(row), apiKey };
}

/**
 * Billing for a call made on behalf of `row`: its own key when it has one, the team key for
 * fixtures and arena-funded units, ZgNotConnectedError when the owner must pay but connected nothing.
 */
export function billingFor(row: BillingRow | null | undefined): Billing {
  if (!row) return { kind: "team" };
  if (row.zgApiKey?.trim() || needsUserBilling(row)) return requireUserBilling(row);
  return { kind: "team" };
}

/** proxy_records.billed_to for a billing. */
export const billedToFor = (billing: Billing): string => (billing.kind === "user" ? billing.userId : "team");
