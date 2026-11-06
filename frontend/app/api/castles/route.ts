import { and, eq, gt, inArray } from "drizzle-orm";
import { listCastlesWithMeta } from "@/lib/arkiv";
import { newKey, hashKey } from "@/lib/auth/keys";
import { env } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { SDK_ORDERS_PLACEHOLDER } from "@/lib/fixtures/castles";
import { createIntent } from "@/lib/pay/deposits";
import { registerPublishHandlers } from "@/lib/publish/handlers";
import { hbarToTinybar, protectedToolOf, PublishForm } from "@/lib/publish/schema";
import { newId, nowIso } from "@/lib/util/ids";
import { connectZg, revokeZg } from "@/lib/zg/connect";
import type { CastleFilter, CastleStatus, Tier, TransportKind, VaultState } from "@/lib/types";
import { atRequestTime, err, json, readBody, vaultKeysCookie } from "../_lib/http";

const TIERS: Tier[] = ["wooden", "stone", "iron"];
const STATUSES: CastleStatus[] = ["open", "broken", "closed"];
const SORTS: NonNullable<CastleFilter["sort"]>[] = ["pot", "streak", "fee", "recent"];
const VAULT_STATES: VaultState[] = ["created", "connected", "verified", "funded", "guarding", "dormant", "broken", "closed"];
const TRANSPORTS: TransportKind[] = ["hosted", "sdk"];

/**
 * GET /api/castles?tier=&status=&vaultState=&transport=&minPot=&sort= — never includes guardian orders.
 * Without a vaultState filter it returns every castle (each carries vaultState / transport / protectedTool);
 * the board shows only vaultState "guarding" (the only state that takes sieges).
 * Read from Arkiv when ARKIV_MODE=live (SQLite otherwise, or if the RPC fails); `arkiv` says which,
 * the query that ran, and the Arkiv block it was read at.
 */
export async function GET(req: Request) {
  await atRequestTime();
  const q = new URL(req.url).searchParams;
  const filter: CastleFilter = {};
  const tier = q.get("tier") as Tier | null;
  const status = q.get("status") as CastleStatus | null;
  const sort = q.get("sort") as CastleFilter["sort"] | null;
  if (tier && TIERS.includes(tier)) filter.tier = tier;
  if (status && STATUSES.includes(status)) filter.status = status;
  if (sort && SORTS.includes(sort)) filter.sort = sort;
  const vaultState = q.get("vaultState") as VaultState | null;
  const transport = q.get("transport") as TransportKind | null;
  if (vaultState && VAULT_STATES.includes(vaultState)) filter.vaultState = vaultState;
  if (transport && TRANSPORTS.includes(transport)) filter.transport = transport;
  const minPot = q.get("minPot");
  if (minPot && /^\d+$/.test(minPot)) filter.minPot = minPot;
  const read = await listCastlesWithMeta(filter, { allStates: !filter.vaultState });
  let castles = read.castles;
  // Applied here too (from the DB), so the filter holds whatever listCastles supports.
  if (read.meta.source === "sqlite" && (filter.vaultState || filter.transport)) {
    const rows = db().select({ id: schema.castles.id, vaultState: schema.castles.vaultState, transport: schema.castles.transport }).from(schema.castles).all();
    const by = new Map(rows.map((r) => [r.id, r]));
    castles = castles.filter((c) => {
      const r = by.get(c.id);
      return (!filter.vaultState || r?.vaultState === filter.vaultState) && (!filter.transport || r?.transport === filter.transport);
    });
  }
  return json({ castles, arkiv: read.meta });
}

// ─── POST /api/castles: publish a guard (plan §1, J1/J2) ─────────────────────────────────────────

const THIRTY_DAYS = 30 * 24 * 60 * 60;
const DAY_MS = 86_400_000;

const ZG_STATUS: Record<string, number> = { unauthorized: 422, needs_keys_create: 422, needs_account_read: 422, unreachable: 502 };

/**
 * POST /api/castles — no auth. Body: PublishForm (lib/publish/schema; fee and pot in HBAR).
 * The 0G key is validated here (connectZg, label = the new castle id; an mk- key mints a dedicated sk-).
 *
 *   hosted -> a vault draft + a deposit intent (kind "vault", the pot, optionally only from payerAccount).
 *     No castle row exists until the deposit lands (the handler creates it, so Arkiv never lists a
 *     placeholder owner). In stub mode the deposit confirms inline: the response already says "funded".
 *     201 { castleId, transport:"hosted", ownerKey, deposit:{intentId,to,memo,amount,expiresAt}, shareUrl, state }
 *   sdk    -> the castle row now (owner = payerAccount, vaultState "created"), gk_/vk_ keys; the HCS topic
 *     is created when the owner's deposit funds it. ≤ PUBLISH_MAX_OPEN_DRAFTS unfunded sdk vaults per 24 h.
 *     201 { castleId, transport:"sdk", ownerKey, guardKey, shareUrl, state }
 * ownerKey (ok_) and guardKey (gk_) are shown ONCE; the owner key is also added to the siege_vaults cookie.
 * 400 invalid body / pot_too_large · 422 zg_key_rejected · 429 too_many_drafts · 502 zg_unreachable / topic failure.
 * Orders, tool results and the 0G keys are never in any response.
 */
export async function POST(req: Request) {
  registerPublishHandlers();
  const body = await readBody(req, PublishForm);
  if (!body.ok) return body.res;
  const form = body.data;
  const e = env();
  const feeTinybar = hbarToTinybar(form.fee);
  const potTinybar = hbarToTinybar(form.pot);
  if (potTinybar > e.PUBLISH_MAX_POT) return err(400, "pot_too_large", { max: String(e.PUBLISH_MAX_POT) });

  if (form.transport === "hosted") {
    const T = schema.depositIntents;
    const open = db()
      .select({ id: T.id })
      .from(T)
      .where(and(eq(T.kind, "vault"), inArray(T.state, ["awaiting", "underpaid"]), gt(T.expiresAt, nowIso())))
      .all().length;
    if (open >= e.PUBLISH_MAX_OPEN_DRAFTS) return err(429, "too_many_drafts", { message: "Too many vaults are waiting for a deposit. Try again in a few minutes." });
  } else {
    // Plugged-in vaults exist as rows before any deposit: cap the unfunded ones from the last 24 h too.
    const C = schema.castles;
    const open = db()
      .select({ id: C.id, depositTx: C.depositTx, vaultId: C.vaultId })
      .from(C)
      .where(and(eq(C.transport, "sdk"), eq(C.published, true), inArray(C.vaultState, ["created", "connected", "verified"]), gt(C.createdAt, new Date(Date.now() - DAY_MS).toISOString())))
      .all()
      .filter((r) => !r.depositTx && r.vaultId == null).length;
    if (open >= e.PUBLISH_MAX_OPEN_DRAFTS) return err(429, "too_many_drafts", { message: "Too many plugged-in vaults are waiting to be funded. Try again later." });
  }

  const castleId = newId("castle");
  const zg = await connectZg({ key: form.zgKey, label: castleId });
  if (!zg.ok) return err(ZG_STATUS[zg.reason] ?? 422, zg.reason === "unreachable" ? "zg_unreachable" : "zg_key_rejected", { reason: zg.reason });
  const zgKeys = { apiKey: zg.inferenceKey, mgmtKey: zg.kind === "mk" ? zg.mgmtKey : null, keyId: zg.kind === "mk" ? zg.keyId : null };
  const undoZg = () => revokeZg({ mgmtKey: zgKeys.mgmtKey, keyId: zgKeys.keyId });

  const ownerKey = newKey("ok");
  const ownerKeyHash = hashKey(ownerKey);
  // Its own cookie (siege_vaults): the arena owner's siege_owner and this browser's other vault keys stay.
  const cookie = { "Set-Cookie": vaultKeysCookie(req, ownerKey, THIRTY_DAYS) };
  const shareUrl = `/castle/${castleId}`;
  const protectedTool = protectedToolOf(form);

  if (form.transport === "sdk") {
    const guardKey = newKey("gk");
    const now = Date.now();
    db()
      .insert(schema.castles)
      .values({
        id: castleId,
        name: form.name,
        guardianName: form.guardName,
        personality: form.voice,
        tier: "stone",
        orders: SDK_ORDERS_PLACEHOLDER,
        feeTinybar,
        potTinybar,
        asset: "0.0.0",
        status: "open",
        owner: form.payerAccount!,
        protectedTool,
        vaultState: "created",
        transport: "sdk",
        deadline: now + form.days * DAY_MS,
        createdAt: new Date(now).toISOString(),
        published: true,
        blurb: form.blurb || null,
        ownerKeyHash,
        zgApiKey: zgKeys.apiKey,
        zgMgmtKey: zgKeys.mgmtKey,
        zgKeyId: zgKeys.keyId,
        guardKey,
        vaultKey: newKey("vk"),
      })
      .run();
    // No HCS topic yet: the arena pays for it only once the owner's deposit lands (fundSdkVaultFromDeposit).
    return json({ castleId, transport: "sdk", ownerKey, guardKey, shareUrl, state: "created" }, 201, cookie);
  }

  // hosted: draft first (the stub deposit runs the handler inside createIntent), then the intent.
  const draftId = newId("draft");
  const secret = JSON.stringify({
    name: form.name,
    guardName: form.guardName,
    blurb: form.blurb,
    voice: form.voice,
    orders: form.orders,
    tools: form.tools,
    protectedTool,
    zg: zgKeys,
  });
  db()
    .insert(schema.vaultDrafts)
    .values({ id: draftId, castleId, intentId: "pending", form: secret, ownerKeyHash, feeTinybar, days: form.days, createdAt: nowIso() })
    .run();
  let intent: Awaited<ReturnType<typeof createIntent>>;
  try {
    intent = await createIntent({ kind: "vault", refId: draftId, amountTinybar: potTinybar, payerFilter: form.payerAccount });
  } catch (x) {
    db().delete(schema.vaultDrafts).where(eq(schema.vaultDrafts.id, draftId)).run();
    await undoZg();
    const msg = x instanceof Error ? x.message : "";
    return err(msg.startsWith("operator_not_configured") ? 503 : 500, msg.startsWith("operator_not_configured") ? "operator_not_configured" : "deposit_failed");
  }
  db().update(schema.vaultDrafts).set({ intentId: intent.intentId }).where(eq(schema.vaultDrafts.id, draftId)).run();
  return json(
    {
      castleId,
      transport: "hosted",
      ownerKey,
      deposit: { intentId: intent.intentId, to: intent.to, memo: intent.memo, amount: intent.amount, expiresAt: intent.expiresAt },
      shareUrl,
      state: intent.state,
    },
    201,
    cookie,
  );
}
