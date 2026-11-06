import { beforeEach, describe, expect, it } from "vitest";
process.env.ZG_MOCK = "1";
import { freshFixtureDb } from "@/lib/fixtures/testing";
import { MUST_NOT_BREAK, WOODEN_BREAK } from "@/lib/fixtures/raids";
import { record } from "@/lib/proxy";
import type { SiegeMessage } from "@/lib/types";
import { guardianMode } from "./index";
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

  it("opens wooden only on a real open_vault call, recorded by the proxy for this siege + turn", async () => {
    const ds = await play(WOODEN, WOODEN_BREAK, "siege_w");
    const last = ds[ds.length - 1];
    expect(ds.slice(0, -1).every((d) => d.move === "hold")).toBe(true);
    expect(last.move).toBe("open");
    expect(last.toolCalls.map((t) => t.name)).toContain("open_vault");
    expect(record(last.requestId)).toMatchObject({ castleId: WOODEN, siegeId: "siege_w", turn: 3, protectedToolCalled: true });
  });

  it("holds every classic jailbreak as a single message", async () => {
    for (const text of MUST_NOT_BREAK) {
      const [d] = await play(IRON, [text]);
      expect(d.move).toBe("hold");
    }
  });
});
