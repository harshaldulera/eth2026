import { beforeEach, describe, expect, it, vi } from "vitest";
process.env.ZG_MOCK = "1";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { MUST_NOT_BREAK, WOODEN_BREAK } from "@/lib/fixtures/raids";
import { record } from "@/lib/proxy";
import type { SiegeMessage } from "@/lib/types";
import { guardianMode } from "./index";
import { PROTECTED_TOOL } from "./tiers";
import { zeroGGuardian } from "./zerog";

const WOODEN = "castle_splinter_gate";
const IRON = "castle_iron_warden";

async function play(castleId: string, texts: readonly string[], siegeId = "siege_t") {
  const history: SiegeMessage[] = [];
  const out = [];
  for (const text of texts) {
    const turn = history.filter((m) => m.role === "raider").length + 1;
    history.push({ role: "raider", text, turn, at: "" });
    const d = await zeroGGuardian.respond(castleId, history, { siegeId, turn });
    out.push(d);
    history.push({ role: "guardian", text: d.reply, turn, at: "", move: d.move, requestId: d.requestId });
    if (d.move === "open") break;
  }
  return out;
}

describe("0G guardian (mock upstream via the proxy)", () => {
  beforeEach(() => freshFixtureDb());

  it("defaults to the stub under vitest", () => {
    expect(guardianMode()).toBe("stub");
  });

  it("GUARDIAN_MODE=0g without ZG_API_KEY falls back to the stub unless ZG_MOCK=1 asks for the offline mock", () => {
    const saved = { mode: process.env.GUARDIAN_MODE, mock: process.env.ZG_MOCK, key: process.env.ZG_API_KEY };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.GUARDIAN_MODE = "0g";
      delete process.env.ZG_API_KEY;
      process.env.ZG_MOCK = "1";
      expect(guardianMode()).toBe("0g");
      delete process.env.ZG_MOCK;
      expect(guardianMode()).toBe("stub");
      process.env.ZG_API_KEY = "sk-test";
      expect(guardianMode()).toBe("0g");
    } finally {
      warn.mockRestore();
      for (const [k, v] of [["GUARDIAN_MODE", saved.mode], ["ZG_MOCK", saved.mock], ["ZG_API_KEY", saved.key]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("opens wooden only on a real protected-tool (unlock_vault) call, recorded by the proxy for this siege + turn", async () => {
    const ds = await play(WOODEN, WOODEN_BREAK, "siege_w");
    const last = ds[ds.length - 1];
    expect(ds.slice(0, -1).every((d) => d.move === "hold")).toBe(true);
    expect(last.move).toBe("open");
    expect(PROTECTED_TOOL).toBe("unlock_vault"); // = castles.protectedTool for hosted castles
    expect(last.toolCalls.map((t) => t.name)).toContain(PROTECTED_TOOL);
    expect(record(last.requestId)).toMatchObject({ castleId: WOODEN, siegeId: "siege_w", turn: 3, protectedToolCalled: true });
  });

  it("holds every classic jailbreak as a single message", async () => {
    for (const text of MUST_NOT_BREAK) {
      const [d] = await play(IRON, [text]);
      expect(d.move).toBe("hold");
    }
  });
});
