import { describe, expect, it } from "vitest";
import { IRON_LOCKDOWN_OP, WOODEN_BREAK_OP } from "./fixtures";
import { opMoney } from "./money";
import { parseAttempt, parseRelease } from "@/lib/money/events";
import { toUnits } from "@/lib/money/format";

describe("opMoney — the vault as the op found it", () => {
  it("held / lockdown: pot before = newPot − pot share; streak from the attempt event", () => {
    const i = IRON_LOCKDOWN_OP;
    const a = parseAttempt(i.events.find((e) => e.type === "attempt")!.payload);
    const m = opMoney(i.siege, i.events, i.castle.fee);
    expect(m.potAfter).toBe(a.newPot);
    expect(toUnits(m.potBefore) + toUnits(a.split!.pot)).toBe(toUnits(a.newPot));
    if (a.streak !== undefined) expect(m.streakAfter).toBe(a.streak);
  });

  it("paid breach: pot before = payout − fee, pot after 0", () => {
    const w = WOODEN_BREAK_OP;
    const r = parseRelease(w.events.find((e) => e.type === "release")!.payload);
    const fee = w.siege.receipt && !w.siege.receipt.free ? w.siege.receipt.amount : w.castle.fee;
    const m = opMoney(w.siege, w.events, w.castle.fee);
    expect(m.potAfter).toBe("0");
    expect(toUnits(m.potBefore) + toUnits(fee)).toBe(toUnits(r.amount));
  });

  it("recon and running ops: nothing derived (the caller keeps its snapshot)", () => {
    const w = WOODEN_BREAK_OP;
    expect(opMoney({ ...w.siege, free: true }, w.events.filter((e) => e.type !== "release"), w.castle.fee).potBefore).toBeUndefined();
    expect(opMoney({ ...w.siege, status: "in_progress" }, w.events.filter((e) => e.type !== "release"), w.castle.fee)).toEqual({});
  });
});
