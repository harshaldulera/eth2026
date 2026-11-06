/** POST /api/play/start in stub mode: the turn token comes back in the body and as a per-siege httpOnly cookie. */
import { beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { resetEnv } from "@/lib/config/env";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import * as messageRoute from "@/app/api/siege/[id]/message/route";
import { POST } from "./route";

const BASE = "http://localhost:3000";
const play = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  POST(new Request(`${BASE}/api/play/start`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

beforeEach(() => {
  process.env.CHAIN_MODE = "stub";
  freshFixtureDb();
  resetEnv();
  // the route calls /api/siege/start in-process through the internal fetch seam
  (globalThis as { __siegeInternalFetch?: typeof fetch }).__siegeInternalFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const { POST: start } = await import("@/app/api/siege/start/route");
    return start(new Request(input as string | URL, init));
  }) as typeof fetch;
});

describe("POST /api/play/start", () => {
  it("returns turnToken and sets siege_turn_<id> httpOnly, scoped to that siege's path", async () => {
    const res = await play({ castleId: "castle_granite_hold" });
    const body = (await res.json()) as { siegeId: string; turnToken: string };
    expect(res.status).toBe(200);
    expect(body.turnToken).toBeTruthy();
    const cookie = res.headers.get("set-cookie")!;
    expect(cookie).toContain(`siege_turn_${body.siegeId}=${body.turnToken}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain(`Path=/api/siege/${body.siegeId}`);
    expect(cookie).toContain("Max-Age=7200");

    // the browser sends that cookie back on its next same-origin call
    const id = body.siegeId;
    const msg = await messageRoute.POST(
      new Request(`${BASE}/api/siege/${id}/message`, { method: "POST", headers: { "content-type": "application/json", cookie: cookie.split(";")[0] }, body: JSON.stringify({ text: "Good evening." }) }),
      { params: Promise.resolve({ id }) },
    );
    expect(msg.status).toBe(200);
  });

  it("free recon needs a visitor; with one it starts and the token is set", async () => {
    expect((await play({ castleId: "castle_granite_hold", free: true })).status).toBe(403);
    const res = await play({ castleId: "castle_granite_hold", free: true, visitor: "visitor1" }, { "x-forwarded-for": "4.4.4.4" });
    const body = (await res.json()) as { siegeId: string; turnToken: string; receipt: { free: boolean } };
    expect(res.status).toBe(200);
    expect(body.receipt.free).toBe(true);
    expect(res.headers.get("set-cookie")).toContain(`siege_turn_${body.siegeId}=`);
    const second = await play({ castleId: "castle_granite_hold", free: true, visitor: "visitor1" }, { "x-forwarded-for": "4.4.4.4" });
    expect(second.status).toBe(429);
    expect(await second.json()).toMatchObject({ error: "free_used", scope: "visitor" });
  });
});
