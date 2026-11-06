import { describe, expect, it } from "vitest";
import type { SiegeEvent } from "@/lib/types";
import { AUDIT_MAX_BYTES, auditMessage } from "./settle";

const at = "2026-11-06T10:00:00.000Z";
const msg = (e: Omit<SiegeEvent, "at">) => JSON.parse(auditMessage({ ...e, at }, "castle_granite_hold")) as Record<string, unknown>;

describe("auditMessage: what the HCS topic shows", () => {
  it("agent.approval carries the decision, the agent, the cap hit and the amount, so requested / approved / denied differ", () => {
    const base = { approvalId: "apr_1", agentId: "agent_night_sapper", reason: "per_castle", amount: "200000000", agentName: "Night Sapper" };
    const requested = msg({ siegeId: "", castleId: "castle_granite_hold", type: "approval", payload: { ...base, kind: "requested" } });
    const approved = msg({ siegeId: "", castleId: "castle_granite_hold", type: "approval", payload: { ...base, kind: "approved", txId: "0.0.1@1.2" } });
    const denied = msg({ siegeId: "", castleId: "castle_granite_hold", type: "approval", payload: { ...base, kind: "denied" } });
    expect(requested).toEqual({
      v: 1,
      type: "agent.approval",
      siegeId: "",
      castleId: "castle_granite_hold",
      kind: "requested",
      approvalId: "apr_1",
      agentId: "agent_night_sapper",
      reason: "per_castle",
      amount: "200000000",
      at,
    });
    expect(approved).toMatchObject({ kind: "approved", txId: "0.0.1@1.2", amount: "200000000", agentId: "agent_night_sapper" });
    expect(denied).toMatchObject({ kind: "denied", approvalId: "apr_1" });
    expect(denied).not.toEqual(requested);
    // Names and free text stay off the topic.
    expect(JSON.stringify([requested, approved, denied])).not.toContain("Night Sapper");
  });

  it("siege.attempt carries the fee and its 80/15/5 split; vault.release the payout", () => {
    const attempt = msg({
      siegeId: "s1",
      castleId: "castle_granite_hold",
      type: "attempt",
      transport: "hosted",
      payload: { txId: "0xabc", transport: "hosted", split: { castellan: "80000000", pot: "15000000", arena: "5000000" } },
    });
    expect(attempt).toMatchObject({ type: "siege.attempt", txId: "0xabc", amount: "100000000", split: { castellan: "80000000", pot: "15000000", arena: "5000000" } });
    const release = msg({ siegeId: "s2", castleId: "castle_granite_hold", type: "release", payload: { txId: "0xdef", transcriptHash: `0x${"ab".repeat(32)}`, amount: "550000000" } });
    expect(release).toMatchObject({ type: "vault.release", txId: "0xdef", amount: "550000000", hash: `0x${"ab".repeat(32)}` });
  });

  it("drops malformed amounts and unknown approval kinds instead of passing them through", () => {
    const m = msg({ siegeId: "", castleId: "c", type: "approval", payload: { kind: "maybe", amount: "-5", approvalId: "a" } });
    expect(m.kind).toBeUndefined();
    expect(m.amount).toBeUndefined();
    const a = msg({ siegeId: "s", castleId: "c", type: "attempt", payload: { txId: "0x1", split: { castellan: "x", pot: "1", arena: "1" } } });
    expect(a.split).toBeUndefined();
    expect(a.amount).toBeUndefined();
  });

  it("stays within the HCS message limit with every field at its longest", () => {
    const long = "x".repeat(5000);
    const out = auditMessage(
      {
        siegeId: long,
        castleId: long,
        type: "approval",
        requestId: long,
        payload: { kind: "approved", approvalId: long, agentId: long, reason: long, amount: "9".repeat(30), txId: long, hash: long },
        at,
      },
      long,
    );
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(AUDIT_MAX_BYTES);
  });
});
