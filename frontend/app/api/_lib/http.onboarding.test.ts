/**
 * Onboarding auth helpers in app/api/_lib/http.ts: per-castle owner keys (ok_) and unit operator
 * keys (rk_). Stub env, in-memory fixture DB.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { hashKey, newKey } from "@/lib/auth/keys";
import { DEFAULT_OWNER_SECRET } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import {
  castleForOwnerKey,
  isOwnerOf,
  OWNER_COOKIE,
  readOperatorKeys,
  requireOwnerOf,
  requireUnitAccess,
  unitAccess,
} from "./http";

const BASE = "http://localhost:3000";
const req = (headers: Record<string, string> = {}) => new Request(`${BASE}/x`, { headers });
const cookie = (v: string) => ({ cookie: `${OWNER_COOKIE}=${encodeURIComponent(v)}` });

let castleA: string;
let castleB: string;
const ownerKeyA = newKey("ok");

function insertAgent(id: string, operatorKeyHash: string | null) {
  db()
    .insert(schema.raiderAgents)
    .values({
      id,
      name: id,
      ownerId: "owner",
      strategy: "authority",
      accountId: `0.0.stub-${id}`,
      budgetTinybar: 100,
      perCastleCapTinybar: 10,
      dailyCapTinybar: 50,
      createdAt: new Date().toISOString(),
      operatorKeyHash,
    })
    .run();
}

beforeEach(() => {
  freshFixtureDb();
  const rows = db().select({ id: schema.castles.id }).from(schema.castles).all();
  castleA = rows[0]!.id;
  castleB = rows[1]!.id;
  db().update(schema.castles).set({ ownerKeyHash: hashKey(ownerKeyA) }).where(eq(schema.castles.id, castleA)).run();
});

describe("isOwnerOf / requireOwnerOf", () => {
  it("the global owner cookie owns every castle", () => {
    expect(isOwnerOf(req(cookie(DEFAULT_OWNER_SECRET)), castleA)).toBe(true);
    expect(isOwnerOf(req(cookie(DEFAULT_OWNER_SECRET)), castleB)).toBe(true);
  });

  it("an ok_ cookie owns only the castle whose owner_key_hash it matches", () => {
    expect(isOwnerOf(req(cookie(ownerKeyA)), castleA)).toBe(true);
    expect(isOwnerOf(req(cookie(ownerKeyA)), castleB)).toBe(false);
    expect(isOwnerOf(req(cookie(newKey("ok"))), castleA)).toBe(false);
    expect(isOwnerOf(req(), castleA)).toBe(false);
  });

  it("an ok_ key also works from the x-siege-owner-key header; an rk_ key never does", () => {
    expect(isOwnerOf(req({ "x-siege-owner-key": ownerKeyA }), castleA)).toBe(true);
    const rk = newKey("rk");
    db().update(schema.castles).set({ ownerKeyHash: hashKey(rk) }).where(eq(schema.castles.id, castleB)).run();
    expect(isOwnerOf(req(cookie(rk)), castleB)).toBe(false);
  });

  it("before the castle row exists, the vault draft's owner_key_hash counts", () => {
    const k = newKey("ok");
    db()
      .insert(schema.vaultDrafts)
      .values({ id: "vd_1", castleId: "castle_pub_1", intentId: "di_1", form: "{}", ownerKeyHash: hashKey(k), feeTinybar: 1, days: 1, createdAt: "now" })
      .run();
    expect(isOwnerOf(req(cookie(k)), "castle_pub_1")).toBe(true);
    expect(isOwnerOf(req(cookie(ownerKeyA)), "castle_pub_1")).toBe(false);
    expect(castleForOwnerKey(k)).toBe("castle_pub_1");
    expect(castleForOwnerKey(ownerKeyA)).toBe(castleA);
    expect(castleForOwnerKey(newKey("ok"))).toBeNull();
    expect(castleForOwnerKey("not-a-key")).toBeNull();
  });

  it("requireOwnerOf: null when allowed, else 401 owner_key_required", async () => {
    expect(requireOwnerOf(req(cookie(ownerKeyA)), castleA)).toBeNull();
    const res = requireOwnerOf(req(cookie(ownerKeyA)), castleB);
    expect(res?.status).toBe(401);
    expect(((await res!.json()) as { error: string }).error).toBe("owner_key_required");
  });
});

describe("operator keys", () => {
  it("readOperatorKeys: comma list header + Bearer rk_, deduplicated, only rk_ keys", () => {
    const [a, b] = [newKey("rk"), newKey("rk")];
    expect(readOperatorKeys(req({ "x-siege-operator-key": ` ${a}, ${b},${a}, junk, ${newKey("ok")}` }))).toEqual([a, b]);
    expect(readOperatorKeys(req({ authorization: `Bearer ${a}` }))).toEqual([a]);
    expect(readOperatorKeys(req({ authorization: `Bearer ${newKey("gk")}` }))).toEqual([]);
    expect(readOperatorKeys(req())).toEqual([]);
  });

  it("unitAccess: owner cookie → owner; matching rk_ → operator; otherwise null", () => {
    const rk = newKey("rk");
    const unit = { operatorKeyHash: hashKey(rk) };
    expect(unitAccess(req(cookie(DEFAULT_OWNER_SECRET)), unit)).toBe("owner");
    expect(unitAccess(req({ "x-siege-operator-key": `${newKey("rk")},${rk}` }), unit)).toBe("operator");
    expect(unitAccess(req({ authorization: `Bearer ${rk}` }), unit)).toBe("operator");
    expect(unitAccess(req({ "x-siege-operator-key": newKey("rk") }), unit)).toBeNull();
    expect(unitAccess(req({ "x-siege-operator-key": rk }), { operatorKeyHash: null })).toBeNull();
    expect(unitAccess(req(cookie(ownerKeyA)), unit)).toBeNull();
  });

  it("requireUnitAccess: 404 unknown unit, 401 without a key, ok with the unit's key or the owner cookie", async () => {
    const rk = newKey("rk");
    insertAgent("agent_op", hashKey(rk));
    insertAgent("agent_arena", null);

    const missing = requireUnitAccess(req(cookie(DEFAULT_OWNER_SECRET)), "agent_nope");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.res.status).toBe(404);
      expect(((await missing.res.json()) as { error: string }).error).toBe("agent_not_found");
    }

    const anon = requireUnitAccess(req(), "agent_op");
    expect(anon.ok).toBe(false);
    if (!anon.ok) {
      expect(anon.res.status).toBe(401);
      expect(((await anon.res.json()) as { error: string }).error).toBe("operator_key_required");
    }

    const op = requireUnitAccess(req({ "x-siege-operator-key": rk }), "agent_op");
    expect(op.ok && op.access).toBe("operator");
    // Another unit's key does not open an arena-funded unit.
    expect(requireUnitAccess(req({ "x-siege-operator-key": rk }), "agent_arena").ok).toBe(false);
    const owner = requireUnitAccess(req(cookie(DEFAULT_OWNER_SECRET)), "agent_arena");
    expect(owner.ok && owner.access).toBe("owner");
  });
});
