/** Free recon caps (per visitor / IP / arena, all-or-none) and the ticket gate on POST /api/siege/start. */
import { beforeEach, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { resetEnv } from "@/lib/config/env";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { mintReconTicket, RECON_TICKET_HEADER, verifyReconTicket } from "@/lib/auth/turn";
import { claimRecon } from "@/lib/pay";
import { utcDay } from "@/lib/util/ids";
import * as startRoute from "@/app/api/siege/start/route";

const BASE = "http://localhost:3000";
const rows = (wallet: string) =>
  db().select().from(schema.freeSieges).where(and(eq(schema.freeSieges.wallet, wallet), like(schema.freeSieges.day, `${utcDay()}%`))).all().length;

const start = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  startRoute.POST(new Request(`${BASE}/api/siege/start`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

beforeEach(() => {
  process.env.CHAIN_MODE = "stub";
  delete process.env.FREE_SIEGES_PER_DAY;
  delete process.env.FREE_RECON_PER_IP_PER_DAY;
  delete process.env.FREE_RECON_PER_DAY_TOTAL;
  freshFixtureDb();
  resetEnv();
});

describe("claimRecon", () => {
  it("allows FREE_SIEGES_PER_DAY per visitor, then names the visitor scope", () => {
    expect(claimRecon({ visitor: "visitor1", ip: "1.1.1.1" })).toEqual({ ok: true });
    expect(claimRecon({ visitor: "visitor1", ip: "1.1.1.1" })).toEqual({ ok: false, scope: "visitor" });
    expect(claimRecon({ visitor: "visitor2", ip: "1.1.1.1" })).toEqual({ ok: true });
  });

  it("caps one IP across many visitors (venue Wi-Fi)", () => {
    process.env.FREE_RECON_PER_IP_PER_DAY = "3";
    resetEnv();
    for (const v of ["aaaaaa1", "aaaaaa2", "aaaaaa3"]) expect(claimRecon({ visitor: v, ip: "9.9.9.9" })).toEqual({ ok: true });
    expect(claimRecon({ visitor: "aaaaaa4", ip: "9.9.9.9" })).toEqual({ ok: false, scope: "ip" });
    expect(claimRecon({ visitor: "aaaaaa4", ip: "8.8.8.8" })).toEqual({ ok: true });
  });

  it("caps the arena as a whole", () => {
    process.env.FREE_RECON_PER_DAY_TOTAL = "2";
    resetEnv();
    expect(claimRecon({ visitor: "bbbbbb1", ip: "1.0.0.1" }).ok).toBe(true);
    expect(claimRecon({ visitor: "bbbbbb2", ip: "1.0.0.2" }).ok).toBe(true);
    expect(claimRecon({ visitor: "bbbbbb3", ip: "1.0.0.3" })).toEqual({ ok: false, scope: "arena" });
  });

  it("is all or none: a refused claim leaves no counts behind", () => {
    process.env.FREE_RECON_PER_IP_PER_DAY = "1";
    resetEnv();
    expect(claimRecon({ visitor: "cccccc1", ip: "7.7.7.7" }).ok).toBe(true);
    expect(rows("arena")).toBe(1);
    // ip full: the visitor and arena rows must not be inserted for the refused claim
    expect(claimRecon({ visitor: "cccccc2", ip: "7.7.7.7" })).toEqual({ ok: false, scope: "ip" });
    expect(rows("recon-cccccc2")).toBe(0);
    expect(rows("arena")).toBe(1);
    expect(rows("ip:7.7.7.7")).toBe(1);
  });
});

describe("recon tickets", () => {
  it("are HMACs bound to the visitor and the UTC day", () => {
    const t = mintReconTicket("visitor1");
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyReconTicket("visitor1", t)).toBe(true);
    expect(verifyReconTicket("visitor2", t)).toBe(false);
    expect(verifyReconTicket("visitor1", t, new Date(Date.now() + 36 * 3600_000))).toBe(false);
    expect(verifyReconTicket("visitor1", "")).toBe(false);
    expect(verifyReconTicket("visitor1", "0".repeat(64))).toBe(false);
  });
});

describe("POST /api/siege/start · free path", () => {
  const free = (wallet: string | undefined, ticket?: string, headers: Record<string, string> = {}) =>
    start({ castleId: "castle_granite_hold", free: true, wallet }, { ...(ticket ? { [RECON_TICKET_HEADER]: ticket } : {}), ...headers });

  it("forgery: a made-up wallet, a missing, wrong or another visitor's ticket are 403 and claim nothing", async () => {
    for (const r of [
      await free("0.0.anything"),
      await free(undefined),
      await free("recon-visitor1"),
      await free("recon-visitor1", "f".repeat(64)),
      await free("recon-visitor1", mintReconTicket("visitor2")),
      await free("recon-VISITOR1", mintReconTicket("VISITOR1")),
    ]) {
      expect(r.status).toBe(403);
      expect(((await r.json()) as { error: string }).error).toBe("recon_requires_visitor");
    }
    expect(db().select().from(schema.freeSieges).all()).toHaveLength(0);
  });

  it("a ticketed visitor starts, gets a turn token, and is then refused with scope visitor", async () => {
    const ok = await free("recon-visitor1", mintReconTicket("visitor1"), { "x-forwarded-for": "5.5.5.5, 10.0.0.1" });
    const body = (await ok.json()) as { siegeId: string; turnToken: string; receipt: { free: boolean; payer: string } };
    expect(ok.status).toBe(200);
    expect(body.receipt).toMatchObject({ free: true, payer: "recon-visitor1" });
    expect(body.turnToken).toBeTruthy();
    // The rightmost x-forwarded-for entry (what the one trusted proxy appended), never the client's leftmost.
    expect(rows("ip:10.0.0.1")).toBe(1);
    const again = await free("recon-visitor1", mintReconTicket("visitor1"), { "x-forwarded-for": "5.5.5.5" });
    expect(again.status).toBe(429);
    expect(await again.json()).toMatchObject({ error: "free_used", scope: "visitor" });
  });

  it("reports the ip and arena scopes", async () => {
    process.env.FREE_RECON_PER_IP_PER_DAY = "1";
    resetEnv();
    await free("recon-visitor1", mintReconTicket("visitor1"), { "x-real-ip": "6.6.6.6" });
    const r = await free("recon-visitor2", mintReconTicket("visitor2"), { "x-real-ip": "6.6.6.6" });
    expect(r.status).toBe(429);
    expect(await r.json()).toMatchObject({ error: "free_used", scope: "ip" });
  });
});
