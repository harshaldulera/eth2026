"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api, describeError, type FundCastleResponse } from "@/lib/api/client";
import { usePolling, useNow } from "@/lib/hooks/usePolling";
import { PLUG_IN } from "@/lib/vocab";
import { cn } from "@/lib/utils";
import { DepositPanel } from "@/components/money/deposit-panel";
import { LED, type LedKind } from "@/components/pixel/led";
import { PixelButton } from "@/components/pixel/button";
import { PixelPanel } from "@/components/pixel/panel";
import type { Castle } from "@/lib/types";

export type PlugInAgentProps = {
  castleId: string;
  /** gk_… shown once on the publish page. Omitted: the owner can mint a new one here. */
  guardKey?: string;
  /** The arena's public URL the harness polls. */
  baseURL: string;
};

type StepState = "todo" | "active" | "done" | "failed";
type Step = { key: string; label: string; state: StepState };

const PAST_VERIFIED = new Set(["verified", "funded", "guarding", "dormant"]);
const mark = (done: boolean, active: boolean, fail = false): StepState => (fail ? "failed" : done ? "done" : active ? "active" : "todo");

/** The six-step strip, derived from the castle's vault state and its SDK status. */
export function stepsOf(castle: Pick<Castle, "vaultState" | "sdk">): { steps: Step[]; failure?: string } {
  const state = castle.vaultState;
  const sdk = castle.sdk;
  const verified = PAST_VERIFIED.has(state);
  const connected = Boolean(sdk?.leaseLive) || state === "connected" || verified;
  const selfChecked = Boolean(sdk?.selfCheckAt) || verified;
  const failed = sdk?.smoke && !sdk.smoke.ok ? sdk.smoke : undefined;
  const held = sdk?.smokeHeld ?? 0;
  const smokeDone = verified || Boolean(sdk?.smoke?.ok);
  const funded = state === "funded" || state === "guarding" || state === "dormant";
  const selfCheckFailed = Boolean(failed?.reason && /self_check|protected_tool/.test(failed.reason));
  const smokeFailed = Boolean(failed) && !selfCheckFailed;
  const steps: Step[] = [
    { key: "connected", label: PLUG_IN.steps.connected, state: mark(connected, !connected) },
    { key: "selfCheck", label: PLUG_IN.steps.selfCheck, state: mark(selfChecked, connected && !selfChecked, selfCheckFailed) },
    { key: "smoke", label: smokeDone ? PLUG_IN.steps.smokeDone : PLUG_IN.steps.smoke(held), state: mark(smokeDone, selfChecked && !smokeDone, smokeFailed) },
    { key: "verified", label: PLUG_IN.steps.verified, state: mark(verified, false) },
    { key: "fund", label: PLUG_IN.steps.fund, state: mark(funded, state === "verified") },
    { key: "guarding", label: PLUG_IN.steps.guarding, state: mark(state === "guarding", state === "funded") },
  ];
  return { steps, failure: failed ? (failed.reason ?? "failed") : undefined };
}

const LED_OF: Record<StepState, LedKind> = { todo: "idle", active: "warn", done: "safe", failed: "live" };

function hintOf(vaultState: string, steps: Step[]): string {
  if (vaultState === "closed" || vaultState === "broken") return PLUG_IN.hint.closed;
  if (vaultState === "dormant") return PLUG_IN.hint.offline;
  if (vaultState === "guarding") return PLUG_IN.hint.guarding;
  if (vaultState === "funded") return PLUG_IN.hint.fund;
  if (vaultState === "verified") return PLUG_IN.hint.verified;
  const active = steps.find((x) => x.state === "active")?.key;
  if (active === "smoke") return PLUG_IN.hint.smoke;
  if (active === "selfCheck") return PLUG_IN.hint.selfCheck;
  return PLUG_IN.hint.connect;
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <PixelButton size="sm" variant="outline" onClick={copy}>
      {done ? PLUG_IN.copied : PLUG_IN.copy}
    </PixelButton>
  );
}

export function PlugInAgent({ castleId, guardKey, baseURL }: PlugInAgentProps) {
  const { data, refresh } = usePolling(() => api.castle(castleId), 2000, { key: castleId });
  const now = useNow(1000);
  const castle = data?.castle;
  const [key, setKey] = useState<string | undefined>(guardKey);
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [fund, setFund] = useState<FundCastleResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const view = castle ? stepsOf(castle) : null;
  const state = castle?.vaultState ?? "created";
  const seen = castle?.lastSeenAt ? Date.parse(castle.lastSeenAt) : NaN;
  const secs = Number.isFinite(seen) && now > 0 ? Math.max(0, Math.round((now - seen) / 1000)) : null;
  const stale = secs !== null && secs > 30;

  const install = "npm i @siege/guard openai";
  const snippet = [
    'import OpenAI from "openai";',
    'import { createGuard } from "@siege/guard";',
    "",
    `const guard = await createGuard({ guardKey: "${key ?? PLUG_IN.keyMissing}", baseURL: "${baseURL}" });`,
    "const openai = new OpenAI(guard.openai);",
    "guard.serve(async (turn) => ({ reply, toolCalls })); // run your agent here",
  ].join("\n");

  async function newKey() {
    setKeyBusy(true);
    setKeyError(null);
    try {
      setKey((await api.rotateGuardKey(castleId)).guardKey);
    } catch (e) {
      setKeyError(e instanceof ApiError && e.code ? e.message : describeError(e) || PLUG_IN.newKeyError);
    } finally {
      setKeyBusy(false);
    }
  }

  async function openFund() {
    setBusy(true);
    setError(null);
    try {
      setFund(await api.fundCastle(castleId));
    } catch (e) {
      setError(e instanceof ApiError && e.code ? e.message : describeError(e) || PLUG_IN.fundError);
    } finally {
      setBusy(false);
    }
  }

  const zgMissing = castle && !castle.zg?.connected && state === "created";

  return (
    <div className="space-y-4">
      <PixelPanel
        title={PLUG_IN.installTitle}
        tone="accent"
        action={<LED kind={state === "guarding" ? "safe" : state === "dormant" ? "offline" : "warn"} label={PLUG_IN.stateLabel(state)} />}
        bodyClassName="space-y-3 p-3"
      >
        <p className="text-[13px] leading-snug text-ink-dim">{PLUG_IN.installHint}</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 border-2 border-line bg-bg px-3 py-2 font-mono text-[12px] break-all text-ink">{install}</code>
          <CopyButton text={install} />
        </div>
        {/* COPY sits in its own row above the code (never over it), and long lines wrap instead of clipping. */}
        <div className="border-2 border-line bg-bg">
          <div className="flex justify-end border-b-2 border-line p-1.5">
            <CopyButton text={snippet} />
          </div>
          <pre className="p-3 font-mono text-[12px] leading-snug break-all whitespace-pre-wrap text-ink">{snippet}</pre>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {key ? <p className="basis-full text-[12px] text-warn">{PLUG_IN.keyOnce}</p> : null}
          <PixelButton size="sm" variant="outline" disabled={keyBusy} onClick={() => void newKey()}>
            {keyBusy ? PLUG_IN.newKeyBusy : PLUG_IN.newKey}
          </PixelButton>
          <span className="text-[11px] text-ink-dim">{PLUG_IN.newKeyWarn}</span>
          {keyError ? (
            <p role="alert" className="w-full text-[12px] text-threat">
              {keyError}
            </p>
          ) : null}
        </div>
      </PixelPanel>

      <PixelPanel
        title={PLUG_IN.stripTitle}
        tone={view?.failure ? "threat" : "default"}
        action={<LED kind={stale ? "warn" : "idle"} label={PLUG_IN.lastPoll(secs)} />}
        bodyClassName="space-y-3 p-3"
      >
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-label={PLUG_IN.stripTitle}>
          {(view?.steps ?? []).map((s) => (
            <li
              key={s.key}
              data-step={s.key}
              data-state={s.state}
              className={cn("border-2 px-2 py-2", s.state === "done" ? "border-safe/60" : s.state === "failed" ? "border-threat" : s.state === "active" ? "border-warn" : "border-line")}
            >
              <LED kind={LED_OF[s.state]} label={s.label} blink={s.state === "active"} />
            </li>
          ))}
        </ol>
        {view?.failure ? (
          <p role="alert" className="border-2 border-threat bg-threat/10 p-2 text-[13px] leading-snug text-threat">
            <span className="font-ui tracking-[0.1em]">{PLUG_IN.failedTitle} · </span>
            {PLUG_IN.failure(view.failure)}
          </p>
        ) : zgMissing ? (
          <p className="text-[13px] leading-snug text-warn">{PLUG_IN.zgMissing}</p>
        ) : view ? (
          <p className="text-[13px] leading-snug text-ink-dim">{hintOf(state, view.steps)}</p>
        ) : null}
      </PixelPanel>

      {state === "verified" && !fund ? (
        <PixelPanel tone="money" title={PLUG_IN.steps.fund} bodyClassName="flex flex-wrap items-center gap-3 p-3">
          <p className="min-w-0 flex-1 text-[13px] text-ink-dim">{PLUG_IN.hint.verified}</p>
          <PixelButton variant="money" disabled={busy} onClick={() => void openFund()}>
            {busy ? PLUG_IN.fundBusy : PLUG_IN.fundButton}
          </PixelButton>
          {error ? (
            <p role="alert" className="w-full text-[12px] text-threat">
              {error}
            </p>
          ) : null}
        </PixelPanel>
      ) : null}
      {fund ? <DepositPanel intentId={fund.deposit.intentId} onFunded={() => void refresh()} /> : null}
    </div>
  );
}
