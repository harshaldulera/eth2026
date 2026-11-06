/** POST /api/owner: the global OWNER_SECRET (unchanged) and per-castle ok_ keys (onboarding). */
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { hashKey, newKey } from "@/lib/auth/keys";
import { DEFAULT_OWNER_SECRET } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { isOwner, isOwnerOf } from "../_lib/http";
import { POST } from "./route";

const BASE = "http://localhost:3000";
const login = (key: unknown) =>
  POST(new Request(`${BASE}/api/owner`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) }));

/** The cookie header a browser would send back after this response. */
const cookieFrom = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0]!;

let castleId: string;
const ownerKey = newKey("ok");

beforeEach(() => {
  freshFixtureDb();
  castleId = db().select({ id: schema.castles.id }).from(schema.castles).get()!.id;
  db().update(schema.castles).set({ ownerKeyHash: hashKey(ownerKey) }).where(eq(schema.castles.id, castleId)).run();
});

describe("POST /api/owner", () => {
  it("global secret: 200 {ok:true} and the httpOnly siege_owner cookie (unchanged)", async () => {
    const res = await login(DEFAULT_OWNER_SECRET);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const sc = res.headers.get("set-cookie") ?? "";
    expect(sc).toMatch(/^siege_owner=/);
    expect(sc).toContain("HttpOnly");
    expect(sc).toContain("SameSite=Lax");
    expect(isOwner(new Request(BASE, { headers: { cookie: cookieFrom(res) } }))).toBe(true);
  });

  it("ok_ key: 200 {ok:true, castleId}, same cookie; it owns that castle only", async () => {
    const res = await login(` ${ownerKey} `);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: true, castleId });
    expect(JSON.stringify(body)).not.toContain(ownerKey);
    const r = new Request(BASE, { headers: { cookie: cookieFrom(res) } });
    expect(isOwnerOf(r, castleId)).toBe(true);
    expect(isOwner(r)).toBe(false);
    const other = db().select({ id: schema.castles.id }).from(schema.castles).all().find((c) => c.id !== castleId)!.id;
    expect(isOwnerOf(r, other)).toBe(false);
  });

  it("unknown ok_ key, wrong secret, or a bad body are refused", async () => {
    expect((await login(newKey("ok"))).status).toBe(401);
    const wrong = await login("not-the-secret");
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: string }).error).toBe("wrong_owner_key");
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect((await login("")).status).toBe(400);
  });
});
