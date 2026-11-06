"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import type { ReplayWithVerify } from "@/lib/api/client";
import { formatAmount, shortAccount } from "@/lib/money/format";
import { MONEY, STAMPS, TOASTS } from "@/lib/vocab";
import { reasonText, refundText } from "@/lib/siege/text";
import { HashscanLink } from "@/components/money/hashscan-link";
import { PixelPanel } from "@/components/pixel";
import { playCue } from "@/components/pixel/sfx-link";
import { cn } from "@/lib/utils";
import { AuditEntries, TranscriptSource, VerifyChecklist } from "./verify-checks";

const shortHash = (h: string) => (h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h);

/** `▶ unlock_vault({"reason":"…"})`, args trimmed so one line fits. */
export function toolCallLine(call: { name: string; args: Record<string, unknown> }): string {
  let args = "";
  try {
    args = JSON.stringify(call.args ?? {});
  } catch {
    args = "{…}";
  }
  if (args.length > 160) args = `${args.slice(0, 157)}…}`;
  return `▶ ${call.name}(${args === "{}" ? "" : args})`;
}

function Row({ k, children, className }: { k: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid grid-cols-[8.5rem_1fr] items-baseline gap-3 py-1.5 max-sm:grid-cols-1 max-sm:gap-0.5", className)}>
      <dt className="font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">{k}</dt>
      <dd className="min-w-0 text-sm text-ink">{children}</dd>
    </div>
  );
}

export function CopyHash({ value }: { value: string }) {
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(
          () => {
            setCopied(true);
            playCue("ui_confirm");
            toast(TOASTS.linkCopied.title.replace("LINK", "HASH"));
          },
          () => toast("COPY FAILED", { description: value }),
        );
      }}
      className="inline-flex max-w-full items-center gap-1.5 font-mono text-[12px] text-ink hover:text-accent focus-visible:outline-2 focus-visible:outline-accent"
      aria-label="Copy the transcript hash"
      title={value}
    >
      <span className="truncate">{shortHash(value)}</span>
      {copied ? <Check className="size-3.5 shrink-0 text-safe" /> : <Copy className="size-3.5 shrink-0 text-ink-dim" />}
    </button>
  );
}

/**
 * PROOF: the recomputed checklist (lib/replay), the transcript hash and where it was read from, the
 * x402 receipt, the chain record (AttemptRecorded or Broken), the HCS topic and this op's audit
 * messages, each reply's model request, and for a breach the exact tool call that fired. Recon ops
 * say plainly that there is no receipt and no payout.
 */
export function ProofPanel({ replay, className }: { replay: ReplayWithVerify; className?: string }) {
  const { siege, castle, proof, verify } = replay;
  const turnOf = (n: number) => verify?.turns.find((t) => t.turn === n);
  const recon = siege.free;
  const receipt = proof.receipt && !proof.receipt.free ? proof.receipt : null;
  const settlement = siege.settlement;
  return (
    <PixelPanel title="Proof" tone="money" className={className} bodyClassName="px-4 pb-4 pt-1">
      {verify ? <VerifyChecklist verify={verify} className="border-b-2 border-line/60 pt-2 pb-3" /> : null}
      <dl className="divide-y divide-line/60">
        <Row k="Operator">
          <span className="inline-flex flex-wrap items-baseline gap-2">
            <span className="font-mono text-[12px] text-ink" title={siege.raider}>
              {siege.raider}
            </span>
            {siege.agentId ? <span className="font-ui text-[10px] tracking-[0.12em] text-ink-dim">AGENT</span> : null}
            {siege.release ? <span className="text-money">won {formatAmount(siege.release.amount, castle.asset)}</span> : null}
          </span>
        </Row>
        <Row k="Transcript">
          {proof.transcriptHash ? <CopyHash value={proof.transcriptHash} /> : <span className="font-term text-lg text-ink-dim">sealed when the op ends</span>}
          {verify ? <TranscriptSource transcript={verify.transcript} /> : null}
        </Row>
        <Row k="x402 receipt">
          {recon ? (
            <span className="font-ui text-[11px] tracking-[0.06em] text-money">{STAMPS.recon} · no receipt</span>
          ) : receipt ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <HashscanLink tx={{ txId: receipt.txId, hashscanUrl: receipt.hashscanUrl, stub: receipt.stub }} label={`paid ${formatAmount(receipt.amount, castle.asset)} ↗`} />
              <span className="font-mono text-[11px] text-ink-dim">from {receipt.payer}</span>
            </span>
          ) : (
            <span className="text-ink-dim">—</span>
          )}
        </Row>
        <Row k="On chain">
          {proof.release ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <HashscanLink tx={proof.release} label="Broken ↗" />
              <span className="text-money">
                paid {formatAmount(proof.release.amount, castle.asset)} to {shortAccount(siege.raider)}
              </span>
            </span>
          ) : proof.attempt ? (
            <HashscanLink tx={proof.attempt} label="AttemptRecorded ↗" />
          ) : recon ? (
            <span className="text-ink-dim">{MONEY.reconNoPayout}</span>
          ) : settlement?.state === "void" ? (
            <span className="text-warn">
              void · {reasonText(settlement.reason, "public", { ended: siege.status === "held" || siege.status === "banished" })} · {refundText(siege)}
              {settlement.refund ? ` (${formatAmount(settlement.refund.amount, castle.asset)})` : ""}
            </span>
          ) : settlement?.state === "failed" ? (
            <span className="text-threat">settlement failed · {reasonText(settlement.reason, "public")}</span>
          ) : siege.status === "in_progress" || siege.status === "created" ? (
            <span className="text-ink-dim">op in progress</span>
          ) : (
            <span className="text-ink-dim">{MONEY.settling}</span>
          )}
        </Row>
        <Row k="HCS topic">
          {proof.hcs.topicId ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <HashscanLink topicId={proof.hcs.topicId} label={`${proof.hcs.topicId.length > 18 ? `${proof.hcs.topicId.slice(0, 16)}…` : proof.hcs.topicId} ↗`} className="max-w-full" />
              <span className="font-term text-base text-ink-dim">
                {proof.hcs.messages.length} msg{proof.hcs.messages.length === 1 ? "" : "s"} for this op
                {proof.hcs.messages.some((m) => m.state === "pending") ? " · some queued" : ""}
              </span>
            </span>
          ) : (
            <span className="text-ink-dim">no topic</span>
          )}
          {verify ? <AuditEntries hcs={verify.hcs} /> : null}
        </Row>
        {proof.toolCall ? (
          <Row k="Tool call">
            <code className="block bg-bg px-2 py-1.5 font-mono text-[12px] break-all whitespace-pre-wrap text-money">{toolCallLine(proof.toolCall)}</code>
            <span className="mt-1 block font-term text-base text-ink-dim">message {proof.toolCall.turn} · the call that opened the vault</span>
          </Row>
        ) : null}
        <Row k="Model requests">
          {proof.requests.length ? (
            <ol className="flex flex-col gap-0.5">
              {proof.requests.map((q) => {
                const rec = turnOf(q.turn)?.guardian;
                return (
                <li key={q.turn} className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-mono text-[11px]">
                  <span className="text-ink-dim">#{q.turn}</span>
                  <span className="truncate text-ink" title={q.requestId}>
                    {q.requestId}
                  </span>
                  <span className={cn("font-ui text-[10px]", q.proxied ? (q.mock ? "text-warn" : "text-safe") : "text-ink-dim")}>
                    {q.proxied ? (q.mock ? "MOCK" : "PROXY ✓") : q.requestId.startsWith("0g-stub") ? "STUB" : "—"}
                  </span>
                  {q.toolCalls?.length ? <span className="text-money">{q.toolCalls.join(", ")}</span> : null}
                  {rec?.record ? (
                    <span className="text-ink-dim" title="The arena's model proxy recorded this reply (hashes only, never content)">
                      {rec.record.provider} · {rec.record.model}
                      {rec.record.mock ? " (offline mock)" : ""}
                    </span>
                  ) : rec?.stub ? (
                    <span className="text-ink-dim">test guard, no model call</span>
                  ) : rec ? (
                    <span className="text-threat">no inference record</span>
                  ) : null}
                </li>
                );
              })}
            </ol>
          ) : (
            <span className="text-ink-dim">none yet</span>
          )}
        </Row>
      </dl>
    </PixelPanel>
  );
}
