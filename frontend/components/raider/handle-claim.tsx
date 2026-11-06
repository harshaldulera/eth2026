"use client";

import { useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ApiError, api, describeError } from "@/lib/api/client";
import { HANDLE } from "@/lib/vocab";
import { PixelButton } from "@/components/pixel/button";
import { PixelPanel } from "@/components/pixel/panel";
import { cn } from "@/lib/utils";

const HANDLE_RE = /^[a-z0-9_-]{3,20}$/i;
const field = "min-h-11 w-full border-2 border-line bg-bg px-2.5 font-term text-[20px] leading-none text-ink focus:border-accent focus:outline-none";

/** Operator keys the unit form stored in this browser (`siege.operatorKeys`: { [agentId]: "rk_…" }). Tolerant of other shapes. */
export function storedOperatorKeys(): string[] {
  try {
    const raw = window.localStorage.getItem("siege.operatorKeys");
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    const vals = Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [];
    return vals.filter((k): k is string => typeof k === "string" && /^rk_\S+$/.test(k));
  } catch {
    return [];
  }
}

function subscribeStorage(cb: () => void) {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
}

/**
 * CLAIM A HANDLE: a public name for the account behind your units (POST /api/operators, operator-key
 * auth). Uses a unit's key from this browser, or asks for one to be pasted.
 *
 * @example <HandleClaim />
 */
export function HandleClaim({ className }: { className?: string }) {
  const stored = useSyncExternalStore(subscribeStorage, () => storedOperatorKeys().join(","), () => "");
  const keys = stored ? stored.split(",") : [];
  const [pasted, setPasted] = useState("");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [mine, setMine] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const key = keys[0] ?? pasted.trim();
  const valid = HANDLE_RE.test(handle.trim());

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return setProblem(HANDLE.invalid);
    if (!/^rk_\S+$/.test(key)) return setProblem(HANDLE.needKey);
    setBusy(true);
    setProblem(null);
    try {
      const r = await api.setHandle(handle.trim(), key);
      setMine(r.handle);
      toast.success(HANDLE.claimed(r.handle));
    } catch (err) {
      const msg =
        err instanceof ApiError && err.code === "handle_taken"
          ? HANDLE.taken
          : err instanceof ApiError && err.code === "operator_key_required"
            ? HANDLE.badKey
            : err instanceof ApiError && err.code === "unit_has_no_account"
              ? HANDLE.noAccount
              : describeError(err);
      setProblem(msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <PixelPanel title={HANDLE.title} tone="inset" className={className} bodyClassName="p-3">
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs leading-relaxed text-ink-dim">{HANDLE.hint}</p>
        {mine ? <p className="font-ui text-[11px] tracking-[0.1em] text-safe uppercase">{HANDLE.current(mine)}</p> : null}
        {keys.length === 0 ? (
          <label className="block">
            <span className="mb-1 block font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">{HANDLE.keyLabel}</span>
            <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={HANDLE.keyPlaceholder} autoComplete="off" spellCheck={false} className={field} />
          </label>
        ) : null}
        <label className="block">
          <span className="sr-only">{HANDLE.title}</span>
          <input
            value={handle}
            onChange={(e) => {
              setHandle(e.target.value);
              setProblem(null);
            }}
            maxLength={20}
            placeholder={HANDLE.placeholder}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problem ? true : undefined}
            className={field}
          />
        </label>
        {problem ? (
          <p role="alert" className="text-xs text-threat">
            {problem}
          </p>
        ) : null}
        <div className="flex items-center gap-3">
          <PixelButton type="submit" variant="money" size="md" disabled={busy || !handle.trim()}>
            {busy ? HANDLE.claiming : HANDLE.claim}
          </PixelButton>
          <Link href="/docs" className={cn("font-ui text-[11px] tracking-[0.08em] text-ink-dim uppercase underline decoration-line underline-offset-4 hover:text-ink")}>
            {HANDLE.docs}
          </Link>
        </div>
      </form>
    </PixelPanel>
  );
}
