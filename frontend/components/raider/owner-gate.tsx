"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, api, describeError } from "@/lib/api/client";
import { BUTTONS } from "@/lib/vocab";
import { Dialog } from "@/components/pixel/dialog";
import { PixelButton } from "@/components/pixel/button";

type Pending = { retry: () => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void; error: unknown };

/**
 * Owner-only actions (create / deploy / stop a unit) without the browser's native `prompt`: run the
 * action; on a 401 a pixel ENTER OWNER KEY dialog opens, the key logs in (httpOnly cookie) and the
 * action runs again. Cancelling rejects with the original 401. Same flow as the vault page's close.
 *
 * @example const owner = useOwnerGate(); await owner.gate(() => api.runAgent(id, body)); … {owner.dialog}
 */
export function useOwnerGate(reason = "Only the owner can create, run or stop raider agents."): {
  gate: <T>(fn: () => Promise<T>) => Promise<T>;
  dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const reset = useCallback(() => {
    setPending(null);
    setKey("");
    setBusy(false);
    setError(null);
  }, []);

  // Hidden by Activity (route change): drop the dialog; the action counts as cancelled.
  useLayoutEffect(
    () => () => {
      const p = pendingRef.current;
      if (p) p.reject(p.error);
      reset();
    },
    [reset],
  );

  const gate = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    return fn().catch((e: unknown) => {
      if (!(e instanceof ApiError) || e.status !== 401) throw e;
      return new Promise<T>((resolve, reject) => {
        setPending({ retry: fn, resolve: resolve as (v: unknown) => void, reject, error: e });
      });
    });
  }, []);

  function cancel() {
    if (busy) return;
    pending?.reject(pending.error);
    reset();
  }

  async function submit() {
    const p = pending;
    if (!p || !key.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.ownerLogin(key.trim());
    } catch (e) {
      setBusy(false);
      setError(e instanceof ApiError && e.status === 401 ? "Wrong key. Try again." : describeError(e));
      return;
    }
    try {
      p.resolve(await p.retry());
    } catch (e) {
      p.reject(e);
    }
    reset();
  }

  const dialog = (
    <Dialog
      open={pending !== null}
      onClose={cancel}
      tone="accent"
      title={BUTTONS.ownerKey}
      actions={
        <>
          <PixelButton size="md" onClick={cancel} disabled={busy}>
            CANCEL
          </PixelButton>
          <PixelButton variant="safe" size="md" disabled={busy || !key.trim()} onClick={() => void submit()}>
            {busy ? "CHECKING…" : "UNLOCK"}
          </PixelButton>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-2"
      >
        <p className="text-sm leading-relaxed text-ink-dim">{reason}</p>
        <label htmlFor="owner-gate-key" className="block font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">
          Owner key
        </label>
        <input
          id="owner-gate-key"
          type="password"
          autoComplete="current-password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          autoFocus
          className="block w-full border-2 border-line bg-bg px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent"
        />
        {error ? (
          <p role="alert" className="text-xs text-threat">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );

  return { gate, dialog };
}
