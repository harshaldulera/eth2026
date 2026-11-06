"use client";

import { useEffect, useRef, useState } from "react";
import { UNITS } from "@/lib/vocab";
import { Dialog } from "@/components/pixel/dialog";
import { PixelButton } from "@/components/pixel/button";

/**
 * YOUR OPERATOR KEY, shown once: the red teamer's `rk_` key for a new unit. COPY, then I SAVED IT.
 * The key is already in this browser's localStorage (lib/agents/operator-keys) before this opens.
 *
 * @example <OperatorKeyDialog open operatorKey={rk} onSaved={() => setOpen(false)} />
 */
export function OperatorKeyDialog({ open, operatorKey, onSaved }: { open: boolean; operatorKey: string; onSaved: () => void }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  function copy() {
    void navigator.clipboard?.writeText(operatorKey).then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  }

  return (
    <Dialog
      open={open}
      // Esc and the backdrop do nothing: the key is shown once, leaving takes a deliberate click.
      onClose={() => undefined}
      title={`${UNITS.keyTitle} · ${UNITS.keyShownOnce}`}
      tone="warn"
      actions={
        <>
          <PixelButton variant="outline" onClick={copy}>
            {copied ? UNITS.keyCopied : UNITS.keyCopy}
          </PixelButton>
          <PixelButton variant="money" onClick={onSaved} data-testid="key-saved">
            {UNITS.keySaved}
          </PixelButton>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-ink-dim">{UNITS.keyBody}</p>
      <p data-testid="operator-key" className="mt-3 border-2 border-warn bg-bg px-2.5 py-2 font-term text-[20px] leading-tight break-all text-ink select-all">
        {operatorKey}
      </p>
      <p className="mt-2 text-xs text-ink-dim">{UNITS.keyStored}</p>
    </Dialog>
  );
}
