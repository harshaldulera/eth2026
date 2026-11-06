import { eq, inArray } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { hashKey } from "@/lib/auth/keys";

/** Operator handles (J5 / plan §3): a public nickname for a red teamer's Hedera account. */
export const HANDLE_RE = /^[a-z0-9_-]{3,20}$/i;

export type SetHandleResult =
  | { ok: true; account: string; handle: string }
  | { ok: false; error: "no_unit_for_key" | "unit_has_no_account" | "handle_taken" };

/**
 * The account a set of `rk_` keys speaks for: the ownerId of the first unit whose operator_key_hash
 * matches. "owner" (the arena's own seeded units) is not a Hedera account and has no handle.
 */
export function accountForOperatorKeys(keys: string[]): { account: string | null; found: boolean } {
  if (!keys.length) return { account: null, found: false };
  const rows = db()
    .select({ ownerId: schema.raiderAgents.ownerId })
    .from(schema.raiderAgents)
    .where(inArray(schema.raiderAgents.operatorKeyHash, keys.map(hashKey)))
    .all();
  const account = rows.find((r) => r.ownerId && r.ownerId !== "owner")?.ownerId ?? null;
  return { account, found: rows.length > 0 };
}

/** Claim or change the handle of `account`. Handles are stored lower-case and are unique. */
export function setHandle(account: string, handleIn: string): SetHandleResult {
  const handle = handleIn.toLowerCase();
  const taken = db().select({ account: schema.operators.account }).from(schema.operators).where(eq(schema.operators.handle, handle)).get();
  if (taken && taken.account !== account) return { ok: false, error: "handle_taken" };
  try {
    db()
      .insert(schema.operators)
      .values({ account, handle, createdAt: new Date().toISOString() })
      .onConflictDoUpdate({ target: schema.operators.account, set: { handle } })
      .run();
  } catch (e) {
    if (/UNIQUE|constraint/i.test(e instanceof Error ? e.message : "")) return { ok: false, error: "handle_taken" };
    throw e;
  }
  return { ok: true, account, handle };
}

export function handleOf(account: string | null | undefined): string | null {
  if (!account) return null;
  return db().select({ h: schema.operators.handle }).from(schema.operators).where(eq(schema.operators.account, account)).get()?.h ?? null;
}

/** account -> handle for a batch (stats). */
export function handlesOf(accounts: string[]): Map<string, string> {
  const uniq = [...new Set(accounts.filter(Boolean))];
  if (!uniq.length) return new Map();
  return new Map(db().select().from(schema.operators).where(inArray(schema.operators.account, uniq)).all().map((r) => [r.account, r.handle]));
}
