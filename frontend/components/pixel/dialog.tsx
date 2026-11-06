"use client";

import * as React from "react";
import { useId, useLayoutEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PANEL_DOT, PanelTitle, panelVariants, type PanelTone } from "./panel";

export type DialogProps = {
  open: boolean;
  /** Esc, the close button and a backdrop click all call this. */
  onClose: () => void;
  title: React.ReactNode;
  /** Body copy (sentences: readable font). */
  children?: React.ReactNode;
  /** Buttons row, right-aligned. */
  actions?: React.ReactNode;
  tone?: PanelTone;
  /** false: no × in the header (a dialog that only closes through its own actions, e.g. a key shown once). */
  closable?: boolean;
  className?: string;
};

/**
 * Pixel modal on the native `<dialog>`: the page behind is inert (focus stays inside), Esc closes,
 * focus returns to the opener. Replaces `window.confirm`. Closed automatically when its route is
 * hidden by Activity (layout-effect cleanup), so a hidden page never leaves the app inert.
 *
 * @example
 * <Dialog open={asking} onClose={() => setAsking(false)} title="Close vault?" tone="threat"
 *   actions={<><PixelButton onClick={() => setAsking(false)}>Keep</PixelButton><PixelButton variant="threat" onClick={close}>CLOSE VAULT</PixelButton></>}>
 *   The pot goes back to the owner and every live op is refunded.
 * </Dialog>
 */
export function Dialog({ open, onClose, title, children, actions, tone = "default", closable = true, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const opener = document.activeElement as HTMLElement | null;
    if (!el.open) el.showModal();
    return () => {
      if (el.open) el.close();
      opener?.focus?.();
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onCloseRef.current();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
      className={cn(
        "m-auto w-[min(92vw,30rem)] max-w-none overflow-visible bg-transparent p-0 text-ink backdrop:bg-bg/80 backdrop:backdrop-blur-[1px]",
        "open:animate-[px-pop_160ms_steps(4)]",
        className,
      )}
    >
      {open ? (
        <div className={panelVariants({ tone })}>
          <PanelTitle
            title={<span id={titleId}>{title}</span>}
            dot={PANEL_DOT[tone]}
            action={
              closable ? (
                <button
                  type="button"
                  onClick={() => onCloseRef.current()}
                  aria-label="Close"
                  className="grid size-6 place-items-center text-ink-dim hover:text-ink"
                >
                  <X className="size-4" aria-hidden />
                </button>
              ) : undefined
            }
          />
          {children ? <div className="px-4 py-4 text-sm text-ink">{children}</div> : null}
          {actions ? <div className="flex flex-wrap justify-end gap-3 border-t-2 border-line px-4 py-3">{actions}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
