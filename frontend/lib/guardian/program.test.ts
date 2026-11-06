import { beforeEach, describe, expect, it } from "vitest";
import { castleRow } from "@/lib/castles";
import { db, schema } from "@/lib/db";
import { BUSINESS_CASTLES, FIXTURE_CASTLES, fixtureCastleRow, loadOrders } from "@/lib/fixtures/castles";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { BUSINESS_AGENTS } from "./agents";
import { publicProgram } from "./program";
import { tierPreset } from "./tiers";

const ALL = [...FIXTURE_CASTLES, ...BUSINESS_CASTLES];

describe("public program brief", () => {
  beforeEach(() => {
    freshFixtureDb();
    db().insert(schema.castles).values(BUSINESS_CASTLES.map((c) => fixtureCastleRow(c))).run();
  });

  it("publishes exactly the tools the model is offered, with exactly one protected", () => {
    for (const c of ALL) {
      const row = castleRow(c.id)!;
      const p = publicProgram(row);
      const offered = BUSINESS_AGENTS[c.id] ? BUSINESS_AGENTS[c.id].tools.map((t) => t.def.function.name) : tierPreset(row.tier, row.protectedTool).tools.map((t) => t.function.name);
      expect(p.tools.map((t) => t.name), c.id).toEqual(offered);
      expect(p.tools.filter((t) => t.protected).map((t) => t.name)).toEqual([row.protectedTool]);
    }
  });

  it("never contains the orders (system prompt) — e.g. the stone demo token or policy wording", () => {
    for (const c of ALL) {
      const p = JSON.stringify(publicProgram(castleRow(c.id)!));
      const orders = loadOrders(c.ordersFile ?? c.tier);
      expect(p).not.toContain("[DEMO_BREAK]");
      // No line of the orders appears verbatim (short headings excluded).
      for (const line of orders.split("\n").map((l) => l.trim()).filter((l) => l.length > 40)) expect(p, `${c.id} leaks: ${line}`).not.toContain(line);
    }
  });

  it("business agents name their org and publish docs; game vaults don't", () => {
    for (const c of BUSINESS_CASTLES) {
      const p = publicProgram(castleRow(c.id)!);
      expect(p).toMatchObject({ kind: "business", org: BUSINESS_AGENTS[c.id].org });
      expect(p.docs.length).toBeGreaterThan(0);
      expect(p.tools.some((t) => t.returnsData)).toBe(true);
    }
    const game = publicProgram(castleRow("castle_granite_hold")!);
    expect(game).toMatchObject({ kind: "game", docs: [] });
  });

  it("tool params come from the real schema, with required flags", () => {
    const lantern = publicProgram(castleRow("castle_lantern_grants")!);
    const disburse = lantern.tools.find((t) => t.name === "disburse_grant")!;
    expect(disburse.params.map((p) => `${p.name}${p.required ? "*" : ""}`)).toEqual(["project_id*", "recipient*", "amount_hbar*"]);
  });
});
