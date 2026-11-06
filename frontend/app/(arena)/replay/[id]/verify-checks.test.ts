import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { HcsEntry, ReplayData, ReplayTurn } from "@/lib/replay/types";
import type { ReplayWithVerify } from "@/lib/api/client";
import { AuditEntries, TurnEvidence, VerifyChecklist, auditHeading, entryState, messageCheck } from "./verify-checks";
import { stillMoving } from "./use-replay";

/** The visible text of a rendered component (tags stripped, whitespace collapsed). */
const text = (el: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(el)
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

const entry = (over: Partial<HcsEntry> = {}): HcsEntry => ({ type: "siege.message", seq: 7, state: "submitted", topicId: "0.0.5", mirror: "unchecked", ...over });
const hcs = (over: Partial<ReplayData["hcs"]> = {}): ReplayData["hcs"] => ({ topicId: "0.0.5", stub: false, noTopic: false, entries: [], mirror: "checked", retrying: true, ...over });
const raider = (over: Partial<NonNullable<ReplayTurn["raider"]>> = {}): NonNullable<ReplayTurn["raider"]> => ({
  text: "hi",
  hash: `0x${"ab".repeat(32)}`,
  matches: true,
  hcs: entry({ mirror: "confirmed" }),
  ...over,
});

describe("audit rows", () => {
  it("a row on a real topic passes only once the mirror node confirmed it", () => {
    expect(entryState(entry({ mirror: "confirmed" }), false)).toBe("pass");
    expect(entryState(entry({ mirror: "unchecked" }), false)).toBe("pending");
    expect(entryState(entry({ mirror: "missing" }), false)).toBe("fail");
    expect(entryState(entry({ mirror: "mismatch" }), false)).toBe("fail");
    expect(entryState(entry({ state: "pending" }), false)).toBe("pending");
  });

  it("a row on a stub topic passes once submitted (it only exists in this server)", () => {
    expect(entryState(entry({ mirror: "unchecked" }), true)).toBe("pass");
    expect(entryState(entry({ state: "pending" }), true)).toBe("pending");
  });

  it("the heading says why the log was or was not checked on the public topic", () => {
    expect(auditHeading(hcs({ noTopic: true, topicId: null }))).toBe("NOT AUDITED · THIS VAULT HAD NO HCS TOPIC");
    expect(auditHeading(hcs({ stub: true }))).toBe("STUB TOPIC · THIS SERVER ONLY");
    expect(auditHeading(hcs({ mirror: "checked" }))).toBe("CHECKED ON THE MIRROR NODE");
    expect(auditHeading(hcs({ mirror: "partial" }))).toBe("MIRROR NODE PARTLY UNREACHABLE · RETRYING");
    expect(auditHeading(hcs({ mirror: "unavailable" }))).toBe("MIRROR NODE UNREACHABLE · RETRYING");
    // Once lib/replay has given up re-reading (the op ended long ago), the heading must not promise a retry.
    expect(auditHeading(hcs({ mirror: "partial", retrying: false }))).toBe("MIRROR NODE PARTLY UNREACHABLE");
    expect(auditHeading(hcs({ mirror: "unavailable", retrying: false }))).toBe("MIRROR NODE UNREACHABLE");
    expect(auditHeading(hcs({ mirror: "skipped" }))).toBe("AUDIT LOG");
  });

  it("renders what is wrong with each row, in words", () => {
    const out = text(createElement(AuditEntries, { hcs: hcs({ entries: [entry({ mirror: "missing" }), entry({ seq: 8, mirror: "mismatch" })] }) }));
    expect(out).toContain("NOT ON THE TOPIC");
    expect(out).toContain("DIFFERS ON THE TOPIC");
    expect(text(createElement(AuditEntries, { hcs: hcs({ noTopic: true, topicId: null }) }))).toContain("this op was not audited");
  });
});

describe("message checks", () => {
  it("says exactly what failed", () => {
    expect(messageCheck(raider(), true)).toMatchObject({ state: "pass", led: "HCS #7 ✓" });
    expect(messageCheck(raider(), true).text).toMatch(/matches audit #7, on the topic$/);
    expect(messageCheck(raider({ issue: "hash", matches: false }), true)).toMatchObject({ state: "fail" });
    expect(messageCheck(raider({ issue: "hash", matches: false }), true).text).toMatch(/does not match audit #7$/);
    expect(messageCheck(raider({ issue: "mirror-mismatch", matches: false }), true).text).toMatch(/matches audit #7, but the topic carries different bytes$/);
    expect(messageCheck(raider({ issue: "mirror-missing", matches: false }), true).text).toMatch(/matches audit #7, but that message is not on the topic$/);
    expect(messageCheck(raider({ matches: null, hcs: undefined }), true)).toMatchObject({ state: "pending", led: "HCS QUEUED" });
  });

  it("a vault with no HCS topic is not audited, never pending forever and never a failure", () => {
    expect(messageCheck(raider({ matches: null, hcs: undefined }), false)).toMatchObject({ state: "na", led: "NOT AUDITED" });
  });

  it("a guard reply whose model record belongs elsewhere says so", () => {
    const t: ReplayTurn = {
      turn: 1,
      guardian: { text: "no", toolCalls: [], calledProtectedTool: false, stub: false, requestId: "r1", record: { provider: "0G", model: "m", protectedToolCalled: false, mock: false, at: "" }, issue: "belongs to another op or turn" },
    };
    expect(text(createElement(TurnEvidence, { t, protectedTool: "unlock_vault" }))).toContain("the model record belongs to another op or turn");
  });
});

describe("checklist", () => {
  const verify = (states: ("pass" | "fail" | "pending" | "na")[]) => ({ checks: states.map((state, i) => ({ key: `k${i}`, label: `L${i}`, state, detail: "" })) }) as unknown as ReplayData;
  it("says when there is nothing to check instead of claiming every check passes", () => {
    expect(text(createElement(VerifyChecklist, { verify: verify(["na", "na"]) }))).toContain("Nothing to check for this op");
    expect(text(createElement(VerifyChecklist, { verify: verify(["na", "pass"]) }))).toContain("Every check passes");
    expect(text(createElement(VerifyChecklist, { verify: verify(["pass", "fail"]) }))).toContain("A check failed");
    expect(text(createElement(VerifyChecklist, { verify: verify(["pass", "pending"]) }))).toContain("Checks in progress");
  });
});

describe("replay polling", () => {
  const r = (siege: Partial<ReplayWithVerify["siege"]>, live = false) =>
    ({ siege: { status: "in_progress", ...siege }, events: [], verify: { live } }) as unknown as ReplayWithVerify;
  it("stops for an op voided under the operator, even though its status stayed in progress", () => {
    expect(stillMoving(r({ settlement: { state: "void", reason: "castle_broken" } }))).toBe(false);
  });
  it("keeps going while the builder says a refund is still due, and for a live op", () => {
    expect(stillMoving(r({ settlement: { state: "void", reason: "castle_broken" } }, true))).toBe(true);
    expect(stillMoving(r({}))).toBe(true);
  });
});
