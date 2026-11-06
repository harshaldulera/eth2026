/**
 * Review fix: free recon cannot be farmed by rotating a client-supplied x-forwarded-for. The per-IP cap
 * uses what the edge appended (rightmost entry / TRUSTED_IP_HEADER), and play/start binds that IP into the
 * recon ticket's HMAC instead of copying the client's header to /api/siege/start.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
process.env.SIEGE_FAST = "1";
import { clientIp, mintBoundReconTicket, mintReconTicket, RECON_IP_HEADER, RECON_TICKET_HEADER } from "@/lib/auth/turn";
import { resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { POST as start } from "@/app/api/siege/start/route";
import { POST } from "./route";

const BASE = "http://localhost:4900";
const play = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  POST(new Request(`${BASE}/api/play/start`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));
const req = (headers: Record<string, string>) => new Request(BASE, { headers });

beforeEach(() => {
  process.env.CHAIN_MODE = "stub";
  process.env.FREE_RECON_PER_IP_PER_DAY = "3";
  freshFixtureDb();
  resetEnv();
  (globalThis as { __siegeInternalFetch?: typeof fetch }).__siegeInternalFetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    start(new Request(input as string | URL, init))) as typeof fetch;
});
afterEach(() => {
  delete process.env.FREE_RECON_PER_IP_PER_DAY;
  delete process.env.TRUSTED_IP_HEADER;
  delete process.env.TRUSTED_PROXY_HOPS;
  resetEnv();
});

describe("clientIp", () => {
  it("takes the entry the trusted proxy appended (rightmost by default), never the client's leftmost", () => {
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.1, 7.7.7.7" }))).toBe("7.7.7.7");
    process.env.TRUSTED_PROXY_HOPS = "2";
    resetEnv();
    expect(clientIp(req({ "x-forwarded-for": "9.9.9.1, 7.7.7.7, 10.0.0.2" }))).toBe("7.7.7.7");
    process.env.TRUSTED_IP_HEADER = "cf-connecting-ip";
    resetEnv();
    expect(clientIp(req({ "x-forwarded-for": "1.1.1.1", "cf-connecting-ip": "8.8.8.8" }))).toBe("8.8.8.8");
    expect(clientIp(req({}))).toBe("local");
  });
});

describe("free recon farming", () => {
  it("rotating visitor ids and the client's own x-forwarded-for hits the per-IP cap", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      // The proxy appends the real address 7.7.7.7; the client varies the part it controls.
      const r = await play({ castleId: "castle_granite_hold", free: true, visitor: `farm${1000 + i}` }, { "x-forwarded-for": `9.9.9.${i}, 7.7.7.7` });
      statuses.push(r.status);
      if (r.status === 429) expect(await r.json()).toMatchObject({ error: "free_used", scope: "ip" });
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429, 429]);
    expect(db().select().from(schema.freeSieges).all().filter((r) => r.wallet === "ip:7.7.7.7")).toHaveLength(3);
  });

  it("siege/start: a bound ticket only works for the IP it was minted for", async () => {
    const call = (headers: Record<string, string>) =>
      start(
        new Request(`${BASE}/api/siege/start`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ castleId: "castle_granite_hold", free: true, wallet: "recon-visitor9" }),
        }),
      );
    const t = mintBoundReconTicket("visitor9", "7.7.7.7");
    expect((await call({ [RECON_TICKET_HEADER]: t, [RECON_IP_HEADER]: "5.5.5.5" })).status).toBe(403);
    expect((await call({ [RECON_TICKET_HEADER]: mintReconTicket("visitor9"), [RECON_IP_HEADER]: "7.7.7.7" })).status).toBe(403);
    expect((await call({ [RECON_TICKET_HEADER]: t, [RECON_IP_HEADER]: "7.7.7.7" })).status).toBe(200);
  });
});
