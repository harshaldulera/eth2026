/**
 * NEW DEPOSIT WINDOW (plan §0 deposit panel, state `expired`): a fresh intent for the same thing, same
 * kind / ref / amount / payer filter, and the ref re-pointed at it. The expired intent stays matchable
 * for its 24 h late grace; each handler notes (never re-funds) a second deposit for the same ref.
 * Server only. No secrets in or out: the caller already holds the intent id.
 */
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { createIntent, getIntent, intentStatus, type CreatedIntent } from "./deposits";

export type RenewResult =
  | { ok: true; intent: CreatedIntent }
  | { ok: false; status: number; error: "deposit_not_found" | "not_expired" | "superseded" | "nothing_to_fund" };

export async function renewIntent(intentId: string, now = Date.now()): Promise<RenewResult> {
  const i = getIntent(intentId);
  const st = intentStatus(intentId, now);
  if (!i || !st) return { ok: false, status: 404, error: "deposit_not_found" };
  if (st.state !== "expired") return { ok: false, status: 409, error: "not_expired" };

  // Only the ref's CURRENT intent can be renewed (one fresh window per expiry, never a pile of them).
  switch (i.kind) {
    case "vault": {
      const d = db().select().from(schema.vaultDrafts).where(eq(schema.vaultDrafts.id, i.refId)).get();
      if (!d) return { ok: false, status: 404, error: "deposit_not_found" };
      if (d.intentId !== i.id) return { ok: false, status: 409, error: "superseded" };
      if (db().select({ id: schema.castles.id }).from(schema.castles).where(eq(schema.castles.id, d.castleId)).get()) {
        return { ok: false, status: 409, error: "nothing_to_fund" };
      }
      break;
    }
    case "vault-sdk": {
      const c = db().select({ s: schema.castles.vaultState }).from(schema.castles).where(eq(schema.castles.id, i.refId)).get();
      if (!c || c.s !== "verified") return { ok: false, status: 409, error: "nothing_to_fund" };
      break;
    }
    case "unit": {
      const d = db().select().from(schema.unitDrafts).where(eq(schema.unitDrafts.id, i.refId)).get();
      if (!d) return { ok: false, status: 404, error: "deposit_not_found" };
      if (d.intentId !== i.id) return { ok: false, status: 409, error: "superseded" };
      if (d.state !== "awaiting" && d.state !== "expired") return { ok: false, status: 409, error: "nothing_to_fund" };
      break;
    }
    case "topup": {
      const a = db().select().from(schema.approvalRequests).where(eq(schema.approvalRequests.id, i.refId)).get();
      if (!a) return { ok: false, status: 404, error: "deposit_not_found" };
      if (a.depositIntentId !== i.id) return { ok: false, status: 409, error: "superseded" };
      if (a.status !== "pending") return { ok: false, status: 409, error: "nothing_to_fund" };
      break;
    }
  }

  const fresh = await createIntent({ kind: i.kind, refId: i.refId, amountTinybar: i.amountTinybar, payerFilter: i.payerFilter });
  const link = fresh.intentId;
  if (i.kind === "vault") db().update(schema.vaultDrafts).set({ intentId: link }).where(eq(schema.vaultDrafts.id, i.refId)).run();
  if (i.kind === "unit") {
    db()
      .update(schema.unitDrafts)
      .set({ intentId: link })
      .where(eq(schema.unitDrafts.id, i.refId))
      .run();
    db()
      .update(schema.unitDrafts)
      .set({ state: "awaiting" })
      .where(and(eq(schema.unitDrafts.id, i.refId), eq(schema.unitDrafts.state, "expired")))
      .run();
  }
  if (i.kind === "topup") db().update(schema.approvalRequests).set({ depositIntentId: link }).where(eq(schema.approvalRequests.id, i.refId)).run();
  return { ok: true, intent: fresh };
}
