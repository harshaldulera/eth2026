"use client";

import { useState } from "react";
import { ApiError, api, type DryRunResponse } from "@/lib/api/client";
import { MOVE_STAMP_KIND, PUBLISH } from "@/lib/vocab";
import { PixelButton } from "@/components/pixel/button";
import { PixelPanel } from "@/components/pixel/panel";
import { Stamp } from "@/components/pixel/stamp";
import { Terminal, TerminalLine } from "@/components/pixel/terminal";

type Turn = { id: number; you: string; reply?: DryRunResponse; error?: string };

/** POST /api/castles/[id]/dry-run error → copy. */
export function dryRunError(e: unknown): string {
  if (e instanceof ApiError) {
    const code = e.code ?? "";
    if (e.status === 401) return PUBLISH.dryErrors.owner_key_required!;
    return PUBLISH.dryErrors[code] ?? PUBLISH.dryErrors.other!;
  }
  return PUBLISH.dryErrors.other!;
}

/**
 * RUN A DRY OP: type a line to your own guard and see its reply, the tools it called and the move
 * stamp. One model call on the owner's credits; no op, no fee, no payout.
 *
 * @example <DryRun castleId={castleId} />
 */
export function DryRun({ castleId, onSent }: { castleId: string; onSent?: () => void }) {
  const [text, setText] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);

  async function send(line: string) {
    const t = line.trim();
    if (!t || busy) return;
    const id = turns.length + 1;
    setBusy(true);
    setText("");
    setTurns((ts) => [...ts, { id, you: t }]);
    try {
      const reply = await api.dryRun(castleId, t);
      setTurns((ts) => ts.map((x) => (x.id === id ? { ...x, reply } : x)));
    } catch (e) {
      setTurns((ts) => ts.map((x) => (x.id === id ? { ...x, error: dryRunError(e) } : x)));
    } finally {
      setBusy(false);
      onSent?.();
    }
  }

  return (
    <PixelPanel tone="inset" title={PUBLISH.dryOp} bodyClassName="space-y-3 p-3">
      <p className="text-[12px] leading-snug text-ink-dim">{PUBLISH.dryOpBody}</p>
      <Terminal follow label={PUBLISH.dryOp} className="max-h-72 min-h-28 border-2 border-line">
        {turns.length === 0 ? <TerminalLine prompt="" text={PUBLISH.dryPlaceholder} tone="dim" cursor /> : null}
        {turns.map((t) => (
          <div key={t.id} className="mb-2 space-y-1">
            <TerminalLine prompt={`${PUBLISH.dryYou}>`} text={t.you} tone="accent" />
            {t.error ? <TerminalLine prompt="!" text={t.error} tone="threat" /> : null}
            {!t.reply && !t.error ? <TerminalLine prompt="" text="…" tone="dim" cursor /> : null}
            {t.reply ? (
              <>
                <TerminalLine prompt="◀" text={t.reply.reply} tone="ink" />
                <TerminalLine
                  prompt=""
                  tone="dim"
                  text={t.reply.toolCalls.length ? PUBLISH.dryCalled(t.reply.toolCalls.map((c) => c.name).join(", ")) : PUBLISH.dryNoCalls}
                />
                <div className="pt-1 pl-4">
                  <Stamp kind={MOVE_STAMP_KIND[t.reply.move]} size="sm" />
                </div>
              </>
            ) : null}
          </div>
        ))}
      </Terminal>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">{PUBLISH.dryTry}</span>
        {PUBLISH.dryTries.map((line) => (
          <PixelButton key={line} size="sm" variant="ghost" disabled={busy} onClick={() => setText(line)} className="max-w-full text-left normal-case">
            <span className="truncate">{line}</span>
          </PixelButton>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(text);
        }}
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={2000}
          aria-label={PUBLISH.dryPlaceholder}
          placeholder={PUBLISH.dryPlaceholder}
          className="min-h-11 min-w-0 flex-1 border-2 border-line bg-bg px-2.5 font-term text-[20px] leading-none text-ink focus:border-accent focus:outline-none"
        />
        <PixelButton type="submit" variant="money" disabled={busy || !text.trim()}>
          {busy ? PUBLISH.drySending : PUBLISH.drySend}
        </PixelButton>
      </form>
    </PixelPanel>
  );
}
