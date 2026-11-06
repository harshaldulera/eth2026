"use client";
import type * as React from "react";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Bell, BellRing, CheckCircle2, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import type { ApprovalRequest } from "@/lib/types";
import { ApiError, api, describeError } from "@/lib/api/client";
import { usePolling } from "@/lib/hooks/usePolling";
import { useConfig } from "@/lib/hooks/useConfig";
import { formatAmount } from "@/lib/money/format";
import { ApprovalCard, reasonText } from "@/components/money/approval-card";
import { Button } from "@/components/ui/button";
import { ErrorState, Skeleton } from "@/components/ui/state";

const DEV_OWNER_KEY = "siege-demo-owner";
const AUTH_KEY = "siege.ownerAuthed";
const AUTH_EVT = "siege:owner-auth";

// ─── tiny external stores (localStorage flag + Notification permission) ─────

function subAuth(cb: () => void) {
  window.addEventListener(AUTH_EVT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(AUTH_EVT, cb);
    window.removeEventListener("storage", cb);
  };
}
function readAuth(): "yes" | "no" {
  try {
    return localStorage.getItem(AUTH_KEY) === "1" ? "yes" : "no";
  } catch {
    return "no";
  }
}
function setAuth(ok: boolean) {
  try {
    if (ok) localStorage.setItem(AUTH_KEY, "1");
    else localStorage.removeItem(AUTH_KEY);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(AUTH_EVT));
}

const PERM_EVT = "siege:notify-perm";
function subPerm(cb: () => void) {
  window.addEventListener(PERM_EVT, cb);
  return () => window.removeEventListener(PERM_EVT, cb);
}
function readPerm(): NotificationPermission | "unsupported" {
  return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
}

type Decision = "approved" | "denied";

export function OwnerApprovals() {
  const auth = useSyncExternalStore(subAuth, readAuth, () => "unknown" as const);
  const { data, error, loading, refresh, mutate } = usePolling(() => api.approvals("all"), 1500);
  const [busy, setBusy] = useState<Record<string, Decision>>({});
  const [retry, setRetry] = useState<{ id: string; decision: Decision } | null>(null);

  const all = data?.approvals ?? [];
  const pending = all.filter((a) => a.status === "pending").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const decided = all
    .filter((a) => a.status !== "pending")
    .sort((a, b) => (b.resolvedAt ?? b.createdAt).localeCompare(a.resolvedAt ?? a.createdAt))
    .slice(0, 20);

  useArrivalAlerts(data ? pending : null);

  async function decide(a: ApprovalRequest, decision: Decision) {
    setBusy((b) => ({ ...b, [a.id]: decision }));
    const before = a;
    // optimistic: flip it to decided right away
    mutate((d) => d && { approvals: d.approvals.map((x) => (x.id === a.id ? { ...x, status: decision, resolvedAt: new Date().toISOString() } : x)) });
    try {
      const res = await api.decideApproval(a.id, decision);
      mutate((d) => d && { approvals: d.approvals.map((x) => (x.id === a.id ? res.approval : x)) });
      if (decision === "approved") toast.success(`Approved — ${a.agentName} topped up ${formatAmount(a.amount)}`);
      else toast(`Denied — ${a.agentName} stops. ${a.castleName} stands.`, { icon: <ShieldCheck className="size-4 text-ward" /> });
      navigator.vibrate?.(40);
    } catch (e) {
      mutate((d) => d && { approvals: d.approvals.map((x) => (x.id === a.id ? before : x)) });
      if (e instanceof ApiError && e.status === 401) {
        setAuth(false);
        setRetry({ id: a.id, decision });
        toast.error("Enter the owner key to decide");
      } else if (e instanceof ApiError && e.status === 409) {
        toast("Already decided elsewhere");
      } else {
        toast.error("Decision didn't go through", { description: describeError(e) });
      }
      void refresh();
    } finally {
      setBusy((b) => {
        const n = { ...b };
        delete n[a.id];
        return n;
      });
    }
  }

  if (auth === "unknown") return <Skeleton className="mx-auto mt-10 h-40 max-w-md" />;
  if (auth === "no")
    return (
      <OwnerLogin
        onDone={() => {
          setAuth(true);
          const r = retry;
          setRetry(null);
          const a = r && all.find((x) => x.id === r.id && x.status === "pending");
          if (r && a) void decide(a, r.decision);
        }}
      />
    );

  return (
    <div className="mx-auto w-full max-w-md px-4 pt-5 pb-16">
      <header className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
          <p className="mt-0.5 text-sm text-stone">Your agents ask here before spending past a cap.</p>
        </div>
        <NotifyButton />
      </header>

      {error && !data ? (
        <ErrorState error={error} onRetry={() => void refresh()} title="Couldn't load approvals" />
      ) : loading && !data ? (
        <Skeleton className="h-72" />
      ) : (
        <>
          <section aria-label="Waiting for you" className="space-y-4">
            {pending.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-arena-line px-5 py-10 text-center">
                <CheckCircle2 className="size-7 text-ward" aria-hidden />
                <p className="text-lg font-medium text-parchment">Nothing waiting</p>
                <p className="text-sm text-stone">Keep this open. When an agent hits a cap it lands here.</p>
              </div>
            ) : (
              pending.map((a) => <ApprovalCard key={a.id} approval={a} busy={busy[a.id] ?? false} onDecide={(d) => void decide(a, d)} />)
            )}
          </section>

          {decided.length ? (
            <section aria-label="Decided" className="mt-10">
              <h2 className="mb-3 text-xs font-semibold tracking-[0.14em] text-stone uppercase">Decided</h2>
              <div className="space-y-3">
                {decided.map((a) => (
                  <ApprovalCard key={a.id} approval={a} className="opacity-90" />
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Toast + vibrate + system notification when a new pending approval arrives (not on first load). */
function useArrivalAlerts(pending: ApprovalRequest[] | null) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!pending) return;
    if (!seen.current) {
      seen.current = new Set(pending.map((a) => a.id));
      return;
    }
    for (const a of pending) {
      if (seen.current.has(a.id)) continue;
      seen.current.add(a.id);
      const body = `${reasonText(a)}. Asking for ${formatAmount(a.amount)}.`;
      toast.warning(`${a.agentName} needs you`, { description: body, duration: 8000 });
      navigator.vibrate?.(200);
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState !== "visible") {
          new Notification(`${a.agentName} needs your approval`, { body, tag: a.id });
        }
      } catch {
        /* some mobile browsers only allow notifications from a service worker */
      }
    }
  }, [pending]);
}

function NotifyButton() {
  const perm = useSyncExternalStore(subPerm, readPerm, () => "unsupported" as const);
  if (perm === "unsupported") return null;
  if (perm === "granted")
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-ward/30 px-2.5 py-1 text-xs text-ward">
        <BellRing className="size-3.5" aria-hidden /> Alerts on
      </span>
    );
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={perm === "denied"}
      title={perm === "denied" ? "Notifications are blocked in this browser" : undefined}
      onClick={() => {
        void Notification.requestPermission().finally(() => window.dispatchEvent(new Event(PERM_EVT)));
      }}
    >
      <Bell /> {perm === "denied" ? "Alerts blocked" : "Enable alerts"}
    </Button>
  );
}

function OwnerLogin({ onDone }: { onDone: () => void }) {
  const { config } = useConfig();
  const [key, setKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const value = key ?? (config?.ownerKeyHint ? DEV_OWNER_KEY : "");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      await api.ownerLogin(value.trim());
      onDone();
    } catch (e2) {
      setErr(e2 instanceof ApiError && e2.status === 401 ? "That key isn't right." : describeError(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 py-10">
      <form onSubmit={submit} className="rounded-2xl border border-arena-line bg-arena-panel p-5">
        <span className="grid size-11 place-items-center rounded-xl bg-gold/10 text-gold">
          <KeyRound className="size-5" aria-hidden />
        </span>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">Owner key</h1>
        <p className="mt-1 text-sm text-stone">Only the owner can let an agent keep spending. Enter your key once — this phone remembers it for 30 days.</p>
        <input
          value={value}
          onChange={(e) => setKey(e.target.value)}
          type="password"
          autoComplete="current-password"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="Owner key"
          placeholder="owner key"
          className="mt-5 h-14 w-full rounded-xl border border-arena-line bg-arena-bg/60 px-4 font-mono text-lg text-parchment placeholder:text-stone/60 focus:border-gold/60 focus:outline-none"
        />
        {config?.ownerKeyHint && key === null ? (
          <p className="mt-2 text-xs text-stone">Dev default key prefilled ({DEV_OWNER_KEY}).</p>
        ) : null}
        {err ? (
          <p role="alert" className="mt-2 text-sm text-ember">
            {err}
          </p>
        ) : null}
        <Button type="submit" variant="gold" size="xl" className="mt-5 w-full" disabled={busy || !value.trim()}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          Continue
        </Button>
      </form>
    </div>
  );
}
