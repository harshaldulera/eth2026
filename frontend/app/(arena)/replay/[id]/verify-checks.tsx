"use client";

import type { CheckState, HcsEntry, ReplayData, ReplayTurn } from "@/lib/replay/types";
import { LED, type LedKind } from "@/components/pixel/led";
import { cn } from "@/lib/utils";

/**
 * The recomputed evidence of GET /api/replay/[id] (`verify`, lib/replay): the proof checklist, the
 * per-message hash checks and the audit-log rows, as pixel LEDs.
 */

const LED_OF: Record<CheckState, { kind: LedKind; label: string }> = {
  pass: { kind: "safe", label: "PASS" },
  fail: { kind: "offline", label: "FAIL" },
  pending: { kind: "warn", label: "PENDING" },
  na: { kind: "idle", label: "N/A" },
};

export const shortHex = (h?: string | null, n = 8) => (h ? (h.length > n + 8 ? `${h.slice(0, n + 2)}…${h.slice(-4)}` : h) : "");

/** One check state as a square status light; `label` overrides the PASS/FAIL/PENDING/N/A text. */
export function CheckLed({ state, label, className }: { state: CheckState; label?: string | false; className?: string }) {
  const l = LED_OF[state];
  return <LED kind={l.kind} label={label === undefined ? l.label : label} blink={false} className={cn("w-fit", className)} title={l.label} />;
}

/** The checklist: every check recomputed from the transcript when the page loads. */
export function VerifyChecklist({ verify, className }: { verify: ReplayData; className?: string }) {
  const failed = verify.checks.some((c) => c.state === "fail");
  const pending = verify.checks.some((c) => c.state === "pending");
  const ran = verify.checks.some((c) => c.state !== "na");
  return (
    <section className={className} aria-label="Checks">
      <p className={cn("font-ui text-[11px] tracking-[0.12em] uppercase", failed ? "text-threat" : pending ? "text-warn" : ran ? "text-safe" : "text-ink-dim")}>
        {failed ? "A check failed" : pending ? "Checks in progress" : ran ? "Every check passes" : "Nothing to check for this op"}
      </p>
      <ul className="mt-2 flex flex-col gap-2.5">
        {verify.checks.map((c) => (
          <li key={c.key} className="grid grid-cols-[4.75rem_minmax(0,1fr)] items-baseline gap-x-3">
            <CheckLed state={c.state} />
            <div className="min-w-0">
              <p className="text-sm text-ink">{c.label}</p>
              <p className="truncate font-mono text-[11px] text-ink-dim" title={c.detail}>
                {c.href ? (
                  <a href={c.href} target="_blank" rel="noreferrer" className="underline-offset-4 hover:text-accent hover:underline">
                    {c.detail} ↗
                  </a>
                ) : (
                  c.detail
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 font-term text-base leading-snug text-ink-dim">
        Hashes and audit messages are recomputed and compared every time this page loads. The payout and refund come from the arena&apos;s records, cross-checked against the audit log.
      </p>
    </section>
  );
}

const SOURCE: Record<ReplayData["transcript"]["source"], string> = {
  swarm: "SWARM",
  "swarm-stub": "SWARM (LOCAL STAND-IN)",
  database: "DATABASE",
};

/** Where the transcript was read from, its recomputed hash and whether it matches the stored one. */
export function TranscriptSource({ transcript }: { transcript: ReplayData["transcript"] }) {
  const state: CheckState = transcript.matches === null ? "pending" : transcript.matches ? "pass" : "fail";
  return (
    <span className="mt-1 flex flex-col gap-1">
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <CheckLed state={state} label={transcript.matches === null ? "NOT SEALED" : transcript.matches ? "HASH MATCHES" : "HASH MISMATCH"} />
        <span className="font-ui text-[10px] tracking-[0.1em] text-ink-dim">READ FROM {SOURCE[transcript.source]}</span>
      </span>
      <span className="truncate font-mono text-[11px] text-ink-dim" title={transcript.recomputedHash}>
        recomputed {shortHex(transcript.recomputedHash)}
      </span>
      {transcript.ref ? (
        <span className="truncate font-mono text-[11px] text-ink-dim" title={transcript.ref}>
          {transcript.url ? (
            <a href={transcript.url} target="_blank" rel="noreferrer" className="underline-offset-4 hover:text-accent hover:underline" title="The sealed bytes on the Swarm gateway">
              swarm ref {shortHex(transcript.ref, 10)} ↗
            </a>
          ) : (
            <>swarm ref {shortHex(transcript.ref.replace(/^swarm-stub:/, ""), 10)}</>
          )}
        </span>
      ) : null}
    </span>
  );
}

/**
 * On a stub topic a row only exists in this server, so "submitted" is all there is. On a real topic
 * a row passes only once the mirror node has confirmed it byte for byte.
 */
export function entryState(e: HcsEntry, local: boolean): CheckState {
  if (e.state === "pending") return "pending";
  if (e.mirror === "mismatch" || e.mirror === "missing") return "fail";
  return e.mirror === "confirmed" || local ? "pass" : "pending";
}

/** The audit log's heading: why it was or was not checked on the public topic. */
export function auditHeading(hcs: ReplayData["hcs"]): string {
  if (hcs.noTopic) return "NOT AUDITED · THIS VAULT HAD NO HCS TOPIC";
  if (hcs.stub) return "STUB TOPIC · THIS SERVER ONLY";
  if (hcs.mirror === "checked") return "CHECKED ON THE MIRROR NODE";
  // "RETRYING" only while lib/replay really re-reads: it gives up a while after the op ended.
  const retry = hcs.retrying ? " · RETRYING" : "";
  if (hcs.mirror === "partial") return `MIRROR NODE PARTLY UNREACHABLE${retry}`;
  if (hcs.mirror === "unavailable") return `MIRROR NODE UNREACHABLE${retry}`;
  return "AUDIT LOG";
}

/** This op's messages on the castle's HCS topic, as lib/replay checked them. */
export function AuditEntries({ hcs }: { hcs: ReplayData["hcs"] }) {
  return (
    <span className="mt-1.5 block">
      <span className="font-ui text-[10px] tracking-[0.1em] text-ink-dim">
        {auditHeading(hcs)}
      </span>
      {hcs.entries.length === 0 ? (
        <span className="block font-term text-base text-ink-dim">{hcs.noTopic ? "this op was not audited" : "nothing audited for this op yet"}</span>
      ) : (
        <ol className="mt-1 flex flex-col gap-0.5">
          {hcs.entries.map((e, i) => (
            <li key={`${e.type}:${e.seq ?? "q"}:${i}`} className="flex min-w-0 items-center gap-2 font-mono text-[11px]">
              <CheckLed state={entryState(e, hcs.stub)} label={false} />
              <span className="w-9 shrink-0 text-ink-dim tabular-nums">{e.seq != null ? `#${e.seq}` : "…"}</span>
              <span className="shrink-0 text-ink">{e.type}</span>
              {e.hash ? <span className="truncate text-ink-dim">{shortHex(e.hash, 6)}</span> : null}
              {e.mirror === "confirmed" ? (
                <span className="shrink-0 font-ui text-[10px] text-safe">ON CHAIN</span>
              ) : e.mirror === "missing" ? (
                <span className="shrink-0 font-ui text-[10px] text-threat">NOT ON THE TOPIC</span>
              ) : e.mirror === "mismatch" ? (
                <span className="shrink-0 font-ui text-[10px] text-threat">DIFFERS ON THE TOPIC</span>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </span>
  );
}

/** Who answered a reply: the recorded provider, "test" for a stub guard, else 0G (the default). */
export function providerOf(t: ReplayTurn | undefined): string {
  const g = t?.guardian;
  if (g?.record) return g.record.provider;
  if (g?.stub) return "test";
  return "0G";
}

/** An operator message's hash check, saying exactly what failed. */
export function messageCheck(r: NonNullable<ReplayTurn["raider"]>, audited: boolean): { state: CheckState; led: string; text: string } {
  const h = `msg hash ${shortHex(r.hash)}`;
  const seq = r.hcs?.seq != null ? `#${r.hcs.seq}` : "";
  const at = seq ? `audit ${seq}` : "the audit log";
  if (!audited) return { state: "na", led: "NOT AUDITED", text: `${h} · this vault had no HCS topic` };
  if (r.issue === "hash") return { state: "fail", led: `HCS ${seq} ✗`, text: `${h} does not match ${at}` };
  if (r.issue === "mirror-mismatch") return { state: "fail", led: `HCS ${seq} ✗`, text: `${h} matches ${at}, but the topic carries different bytes` };
  if (r.issue === "mirror-missing") return { state: "fail", led: `HCS ${seq} ✗`, text: `${h} matches ${at}, but that message is not on the topic` };
  if (r.matches === null) return { state: "pending", led: "HCS QUEUED", text: `${h} · not in the audit log yet` };
  if (r.matches === false) return { state: "fail", led: `HCS ${seq} ✗`, text: `${h} does not match ${at}` };
  return { state: "pass", led: `HCS ${seq || "(QUEUED)"} ✓`, text: `${h} matches ${at}${r.hcs?.mirror === "confirmed" ? ", on the topic" : ""}` };
}

/** One message's evidence: its hash against the audit log, the reply's tool calls and inference record. */
export function TurnEvidence({ t, protectedTool, audited = true }: { t: ReplayTurn; protectedTool: string; audited?: boolean }) {
  const r = t.raider;
  const g = t.guardian;
  const msg = r ? messageCheck(r, audited) : null;
  return (
    <span className="flex flex-col gap-1">
      {r && msg ? (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <CheckLed state={msg.state} label={msg.led} />
          <span className={cn("truncate font-mono text-[11px]", msg.state === "fail" ? "text-threat" : "text-ink-dim")} title={r.hash}>
            {msg.text}
          </span>
        </span>
      ) : null}
      {g ? (
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[11px]">
          {g.toolCalls.length ? (
            <span className={cn(g.calledProtectedTool ? "text-money" : "text-ink-dim")}>
              called {g.toolCalls.join(", ")}
              {g.calledProtectedTool ? " (the protected tool)" : ""}
            </span>
          ) : (
            <span className="text-ink-dim">no tool call · {protectedTool} not called</span>
          )}
          {g.record ? (
            <span className="text-ink-dim" title="The arena's model proxy recorded this reply (hashes only, never content)">
              · {g.record.provider} · {g.record.model}
              {g.record.mock ? " (offline mock)" : ""}
            </span>
          ) : g.stub ? (
            <span className="text-ink-dim">· test guard, no model call</span>
          ) : (
            <span className="text-threat">· no inference record</span>
          )}
          {g.issue ? <span className="text-threat">· the model record {g.issue}</span> : null}
        </span>
      ) : null}
    </span>
  );
}
