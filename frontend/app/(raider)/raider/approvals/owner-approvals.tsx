"use client";
import type * as React from "react";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { ApprovalRequest } from "@/lib/types";
import { ApiError, api, describeError } from "@/lib/api/client";
import { usePolling } from "@/lib/hooks/usePolling";
import { useConfig } from "@/lib/hooks/useConfig";
import { formatAmount } from "@/lib/money/format";
import { BUTTONS, EMPTY, TOASTS, UNITS } from "@/lib/vocab";
import { hasOperatorKeys, OPERATOR_KEYS_EVENT } from "@/lib/agents/operator-keys";
import { DepositPanel } from "@/components/money/deposit-panel";
import { PixelPanel } from "@/components/pixel/panel";
import { ApprovalCard, approveMovesMoney, reasonText } from "@/components/money/approval-card";
import { Pager } from "@/components/pixel/pager";
import { PixelButton } from "@/components/pixel/button";
import { Sprite } from "@/components/pixel/sprite";
import { playCue } from "@/components/pixel/sfx-link";
import { ErrorState, Skeleton } from "@/components/ui/state";

const DEV_OWNER_KEY = "siege-demo-owner";
const AUTH_KEY = "siege.ownerAuthed";
const AUTH_EVT = "siege:owner-auth";
/** Decided sheets shown in full under the waiting ones (the rest are one-line rows). */
const RECENT_FULL = 1;

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

// Operator keys (a red teamer's units) live in localStorage `siege.operatorKeys`: with one, the pager works without the owner key.
function subKeys(cb: () => void) {
  window.addEventListener(OPERATOR_KEYS_EVENT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(OPERATOR_KEYS_EVENT, cb);
    window.removeEventListener("storage", cb);
  };
}
function readKeys(): "yes" | "no" {
  return hasOperatorKeys() ? "yes" : "no";
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
  const keyed = useSyncExternalStore(subKeys, readKeys, () => "unknown" as const);
  const { data, error, loading, refresh, mutate } = usePolling(() => api.approvals("all"), 1500);
  // Decisions in flight. They override what the poll says until the server answers, so a poll that
  // left before the tap can't flip the sheet back to pending.
  const [busy, setBusy] = useState<Record<string, { decision: Decision; at: string }>>({});
  const [retry, setRetry] = useState<{ id: string; decision: Decision } | null>(null);

  const all = (data?.approvals ?? []).map((x) => {
    const b = busy[x.id];
    return b && x.status === "pending" ? { ...x, status: b.decision, resolvedAt: b.at } : x;
  });
  const pending = all.filter((a) => a.status === "pending").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const decided = all
    .filter((a) => a.status !== "pending")
    .sort((a, b) => (b.resolvedAt ?? b.createdAt).localeCompare(a.resolvedAt ?? a.createdAt))
    .slice(0, 20);

  useArrivalAlerts(data ? pending : null);

  async function decide(a: ApprovalRequest, decision: Decision) {
    setBusy((b) => ({ ...b, [a.id]: { decision, at: new Date().toISOString() } }));
    const before = a;
    // optimistic: flip it to decided right away
    mutate((d) => d && { approvals: d.approvals.map((x) => (x.id === a.id ? { ...x, status: decision, resolvedAt: new Date().toISOString() } : x)) });
    try {
      const res = await api.decideApproval(a.id, decision);
      mutate((d) => d && { approvals: d.approvals.map((x) => (x.id === a.id ? res.approval : x)) });
      // A budget ask on a unit you funded answers with a top-up deposit and stays pending until it lands.
      if (res.approval.status === "pending" && res.approval.deposit) toast(UNITS.topUpTitle, { description: UNITS.topUpHint });
      else if (decision === "approved")
        toast.success(
          (approveMovesMoney(res.approval) ? TOASTS.approved(a.agentName, formatAmount(a.amount)) : TOASTS.capRaised(a.agentName, formatAmount(a.amount))).title,
        );
      else toast(TOASTS.denied(a.agentName, a.castleName).title);
      navigator.vibrate?.(40);
    } catch (e) {
      mutate((d) => d && { approvals: d.approvals.map((x) => (x.id === a.id ? before : x)) });
      if (e instanceof ApiError && e.status === 401 && keyed === "yes") {
        toast.error("That key doesn't cover this unit");
      } else if (e instanceof ApiError && e.status === 401) {
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

  if (auth === "unknown" || keyed === "unknown") return <Skeleton className="mx-auto mt-10 h-40 max-w-md" />;
  if (auth === "no" && keyed === "no")
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

  // One keyed list (waiting, then decided) so a sheet decided on screen stays mounted and flips.
  const items: React.ReactNode[] = [
    ...pending.flatMap((a) => [
      <ApprovalCard key={a.id} approval={a} busy={busy[a.id]?.decision ?? false} onDecide={(d) => void decide(a, d)} />,
      ...(a.deposit
        ? [
            <PixelPanel key={`${a.id}:topup`} title={UNITS.topUpTitle} bodyClassName="space-y-3 p-4">
              <p className="text-xs leading-relaxed text-ink-dim">{UNITS.topUpHint}</p>
              <DepositPanel key={a.deposit.intentId} intentId={a.deposit.intentId} onFunded={() => void refresh()} />
            </PixelPanel>,
          ]
        : []),
    ]),
  ];
  if (decided.length) {
    items.push(
      <h2 key="__decided" className="mt-2 border-t-2 border-dashed border-line pt-4 font-ui text-[11px] tracking-[0.16em] text-ink-dim uppercase">
        Decided
      </h2>,
    );
    decided.forEach((a, i) => items.push(<ApprovalCard key={a.id} approval={a} compact={i >= RECENT_FULL} />));
  }

  return (
    <div className="w-full px-3 pt-4 pb-16 sm:pt-8">
      <Pager title={`PAGER · ${pending.length} WAITING`} alert={pending.length > 0} action={<NotifyButton />}>
        {error && !data ? (
          <ErrorState error={error} onRetry={() => void refresh()} title="Couldn't reach the pager" />
        ) : loading && !data ? (
          <Skeleton className="h-72" />
        ) : (
          <>
            {pending.length === 0 ? (
              <div className="flex flex-col items-center gap-2 border-2 border-dashed border-line px-5 py-8 text-center">
                <Sprite name="pager" scale={3} animate />
                <p className="mt-1 font-ui text-base tracking-[0.08em] text-ink uppercase">{EMPTY.nothingWaiting.title}</p>
                <p className="text-sm text-ink-dim">{EMPTY.nothingWaiting.body}</p>
              </div>
            ) : null}
            {items}
          </>
        )}
      </Pager>
    </div>
  );
}

/** Toast + radio cue + vibrate + system notification when a new pending approval arrives (not on first load). */
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
      const t = TOASTS.needsYou(a.agentName, reasonText(a), formatAmount(a.amount));
      toast.warning(t.title, { description: t.body, duration: 8000 });
      playCue("radio_call");
      navigator.vibrate?.(200);
      try {
        if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState !== "visible") {
          new Notification(`${a.agentName} needs your approval`, { body: t.body, tag: a.id });
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
  if (perm === "granted") return <span className="shrink-0 font-ui text-[10px] tracking-[0.1em] text-accent uppercase">ALERTS ON</span>;
  if (perm === "denied")
    return (
      <span className="shrink-0 font-ui text-[10px] tracking-[0.1em] text-ink-dim uppercase" title="Notifications are blocked in this browser">
        ALERTS OFF
      </span>
    );
  return (
    <PixelButton
      size="sm"
      variant="outline"
      className="shrink-0"
      onClick={() => {
        void Notification.requestPermission().finally(() => window.dispatchEvent(new Event(PERM_EVT)));
      }}
    >
      ALERTS
    </PixelButton>
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
      playCue("power_on");
      onDone();
    } catch (e2) {
      setErr(e2 instanceof ApiError && e2.status === 401 ? "That key isn't right." : describeError(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full px-3 pt-4 pb-16 sm:pt-8">
      <Pager title="PAGER · LOCKED">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Sprite name="padlock" scale={3} />
            <p className="text-[15px] leading-snug text-ink/90">
              Only the owner can let a unit keep spending. Enter your key once; this phone remembers it for 30 days.
            </p>
          </div>
          <label className="block">
            <span className="mb-1 block font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">Owner key</span>
            <input
              value={value}
              onChange={(e) => setKey(e.target.value)}
              type="password"
              autoComplete="current-password"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder="owner key"
              className="min-h-14 w-full border-2 border-line bg-bg px-4 font-mono text-lg text-ink placeholder:text-ink-dim/60 focus:border-accent focus:outline-none"
            />
          </label>
          {config?.ownerKeyHint && key === null ? <p className="-mt-2 text-xs text-ink-dim">Dev default key prefilled ({DEV_OWNER_KEY}).</p> : null}
          {err ? (
            <p role="alert" className="-mt-2 text-sm text-threat">
              {err}
            </p>
          ) : null}
          <PixelButton type="submit" variant="money" size="xl" className="w-full" disabled={busy || !value.trim()}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {BUTTONS.ownerKey}
          </PixelButton>
        </form>
      </Pager>
    </div>
  );
}
