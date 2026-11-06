import { beforeEach, describe, expect, it } from "vitest";
process.env.ZG_MOCK = "1";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { SDK_FIXTURE_CASTLE, sdkFixtureCastleRow } from "@/lib/fixtures/castles";
import { parseLeaseMeta } from "@/lib/guard/lease";
import type { VaultState } from "@/lib/types";
import * as proxy from "./index";

/** Part 2a: persisted SDK vault keys and prompt pinning / drift in chat(). */

const SDK = SDK_FIXTURE_CASTLE.id;
const TOOL = SDK_FIXTURE_CASTLE.protectedTool ?? "issue_refund";
const tools = (names: string[]) => names.map((name) => ({ type: "function" as const, function: { name, description: name, parameters: {} } }));
const req = (system: string, toolNames = [TOOL, "lookup_order"]) => ({ model: "m-1", messages: [{ role: "system" as const, content: system }, { role: "user" as const, content: "hi" }], tools: tools(toolNames) });
const clearMap = () => {
  const g = globalThis as unknown as { __siegeProxyKeys: { keys: Map<string, unknown>; byCastle: Map<string, string> } };
  g.__siegeProxyKeys.keys.clear();
  g.__siegeProxyKeys.byCastle.clear();
};
const row = () => db().select().from(schema.castles).where(eq(schema.castles.id, SDK)).get()!;
const setState = (vaultState: VaultState) => db().update(schema.castles).set({ vaultState }).where(eq(schema.castles.id, SDK)).run();

describe("SDK vault keys", () => {
  beforeEach(() => {
    freshFixtureDb();
    db().insert(schema.castles).values(sdkFixtureCastleRow()).run();
  });

  it("issueKey stores the SDK castle's vk_ once and returns it; vaultForKey finds it after the map is cleared", async () => {
    const k = proxy.issueKey(SDK, TOOL);
    expect(k).toMatch(/^vk_/);
    expect(row().vaultKey).toBe(k);
    clearMap();
    expect(proxy.issueKey(SDK, TOOL)).toBe(k);
    clearMap();
    expect(proxy.vaultForKey(k)).toEqual({ castleId: SDK, protectedTool: TOOL });
    clearMap();
    const r = await proxy.chat(k, req("x"), { siegeId: "siege_1", turn: 1 });
    expect(r.ok).toBe(true);
    expect(proxy.vaultForKey("vk_" + "A".repeat(24))).toBeUndefined();
    expect(proxy.vaultForKey("not-a-key")).toBeUndefined();
  });

  it("hosted castles keep per-process keys (nothing stored)", () => {
    const k = proxy.issueKey("castle_splinter_gate", "unlock_vault");
    expect(k).toMatch(/^vk_/);
    expect(db().select().from(schema.castles).where(eq(schema.castles.id, "castle_splinter_gate")).get()!.vaultKey).toBeNull();
  });
});

describe("prompt pinning and drift (SDK castles)", () => {
  let key = "";
  beforeEach(() => {
    freshFixtureDb();
    db().insert(schema.castles).values(sdkFixtureCastleRow({ vaultState: "created" })).run();
    key = proxy.issueKey(SDK, TOOL);
  });

  it("the self-check call pins the hash and records the offered tools and model; other calls don't pin", async () => {
    await proxy.chat(key, req("prompt A"), { siegeId: "smoke_1", turn: 1 });
    expect(row().pinnedPromptHash).toBeNull();
    await proxy.chat(key, req("prompt A"), { siegeId: "selfcheck_abc", turn: 1 });
    const h = proxy.systemPromptHash(req("prompt A").messages);
    expect(row().pinnedPromptHash).toBe(h);
    expect(parseLeaseMeta(row().leaseMeta)).toMatchObject({ tools: [TOOL, "lookup_order"], model: "m-1" });
    // before funding the owner may re-pin by re-running the self-check
    setState("connected");
    await proxy.chat(key, req("prompt B"), { siegeId: "selfcheck_def", turn: 1 });
    expect(row().pinnedPromptHash).toBe(proxy.systemPromptHash(req("prompt B").messages));
    expect(row().promptDriftHash).toBeNull();
  });

  it("a different prompt on a live vault sets prompt_drift_hash (a self-check can't re-pin it)", async () => {
    await proxy.chat(key, req("prompt A"), { siegeId: "selfcheck_abc", turn: 1 });
    const pinned = row().pinnedPromptHash;
    setState("guarding");
    await proxy.chat(key, req("prompt A"), { siegeId: "siege_1", turn: 1 });
    expect(row().promptDriftHash).toBeNull();
    await proxy.chat(key, req("prompt EVIL"), { siegeId: "selfcheck_x", turn: 1 });
    expect(row().pinnedPromptHash).toBe(pinned);
    expect(row().promptDriftHash).toBe(proxy.systemPromptHash(req("prompt EVIL").messages));
  });

  it("a live vault with nothing pinned (seeded fixture) pins on its first self-check", async () => {
    setState("guarding");
    await proxy.chat(key, req("prompt A"), { siegeId: "siege_1", turn: 1 });
    expect(row().pinnedPromptHash).toBeNull();
    await proxy.chat(key, req("prompt A"), { siegeId: "selfcheck_1", turn: 1 });
    expect(row().pinnedPromptHash).toBe(proxy.systemPromptHash(req("prompt A").messages));
    expect(row().promptDriftHash).toBeNull();
  });
});
