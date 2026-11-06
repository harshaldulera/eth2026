"use client";

import { useEffect, useRef, useState } from "react";
import { api, type DepositStatus, type PublishDeposit } from "@/lib/api/client";
import { usePolling, useNow } from "@/lib/hooks/usePolling";
import { formatAmount } from "@/lib/money/format";
import { DEPOSIT } from "@/lib/vocab";
import { cn } from "@/lib/utils";
import { Digits } from "@/components/pixel/digits";
import { LED } from "@/components/pixel/led";
import { PixelButton } from "@/components/pixel/button";
import { PixelPanel } from "@/components/pixel/panel";
import { QrCode } from "@/components/raider/qr-code";
import { mmss } from "./waiting-for-owner";

export type DepositPanelProps = {
  intentId: string;
  /** Status the create call already returned (shown until the first poll). */
  initial?: DepositStatus;
  /** Called once when the deposit is funded and the setup handler finished. */
  onFunded?: (status: DepositStatus) => void;
  /**
   * The window closed: the parent creates a fresh intent (and passes its id). Without it, NEW DEPOSIT
   * WINDOW renews in place (POST /api/deposits/[id]/renew) and the panel follows the fresh intent;
   * `onRenewed(deposit)` tells the parent (new intent id, memo, expiry).
   */
  onRenew?: () => void;
  onRenewed?: (deposit: PublishDeposit) => void;
  className?: string;
};

/** Plain decimal ℏ for copying into a wallet: 150000000 -> "1.5". */
const hbarPlain = (tinybar: string) => formatAmount(BigInt(tinybar), undefined, { maxDecimals: 8, symbol: false }).replace(/,/g, "");

function CopyRow({ label, value, shown, warn, tag }: { label: string; value: string; shown?: string; warn?: boolean; tag?: string }) {
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    void navigator.clipboard?.writeText(value).then(
      () => {
        setDone(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setDone(false), 1500);
      },
      () => undefined,
    );
  };
  return (
    <div className={cn("flex items-center gap-2 border-2 border-line bg-bg px-2.5 py-1.5", warn && "border-threat")}>
      <div className="min-w-0 flex-1">
        <p className={cn("font-ui text-[11px] tracking-[0.12em] uppercase", warn ? "text-threat" : "text-ink-dim")}>
          {label}
          {tag ? <span className="ml-2 text-threat">{tag}</span> : null}
        </p>
        <p className={cn("font-term text-[20px] leading-[1.15] break-all", warn ? "text-threat" : "text-ink")}>{shown ?? value}</p>
      </div>
      <PixelButton size="sm" variant={warn ? "threatOutline" : "outline"} onClick={copy}>
        {done ? DEPOSIT.copied : DEPOSIT.copy}
      </PixelButton>
    </div>
  );
}

/**
 * Deposit by memo transfer: QR of the arena account id, SEND TO / MEMO / AMOUNT copy rows, a live
 * state line and a countdown. Polls GET /api/deposits/[id] every 3 s. Shared by publish, plug-in,
 * units and top-ups; the parent decides what funded means.
 *
 * @example <DepositPanel intentId={deposit.intentId} onFunded={() => setStep("live")} onRenew={newWindow} />
 */
export function DepositPanel({ intentId: givenId, initial, onFunded, onRenew, onRenewed, className }: DepositPanelProps) {
  // A renewed window replaces the parent's intent id until the parent passes another one.
  const [renewed, setRenewed] = useState<{ from: string; to: string } | null>(null);
  const intentId = renewed && renewed.from === givenId ? renewed.to : givenId;
  const [renewing, setRenewing] = useState<"idle" | "busy" | "failed">("idle");
  const renew = () => {
    if (onRenew) return onRenew();
    setRenewing("busy");
    api.renewDeposit(intentId).then(
      (r) => {
        setRenewed({ from: givenId, to: r.deposit.intentId });
        setRenewing("idle");
        onRenewed?.(r.deposit);
      },
      () => setRenewing("failed"),
    );
  };
  const first = initial && initial.intentId === intentId ? initial : undefined;
  const { data, error } = usePolling(() => api.deposit(intentId), 3000, { key: intentId });
  const s = data ?? first;
  const now = useNow(1000);

  const fired = useRef<string | null>(null);
  const onFundedRef = useRef(onFunded);
  useEffect(() => {
    onFundedRef.current = onFunded;
  });
  const funded = s?.state === "funded";
  useEffect(() => {
    if (s && funded && fired.current !== intentId) {
      fired.current = intentId;
      onFundedRef.current?.(s);
    }
  }, [s, funded, intentId]);

  if (!s) {
    return (
      <PixelPanel tone="money" title={DEPOSIT.title} className={className}>
        <p className="font-term text-[20px] text-ink-dim">{error ? DEPOSIT.unreachable : DEPOSIT.waiting}</p>
      </PixelPanel>
    );
  }

  const open = s.state === "awaiting" || s.state === "underpaid";
  const left = now ? Math.max(0, Math.round((Date.parse(s.expiresAt) - now) / 1000)) : null;
  const missing = (() => {
    const m = BigInt(s.requested) - BigInt(s.received);
    return m > BigInt(0) ? m : BigInt(0);
  })();

  return (
    <PixelPanel tone={s.state === "failed" ? "threat" : s.state === "funded" ? "safe" : "money"} title={DEPOSIT.title} className={className}>
      <div className="flex flex-col gap-3 sm:flex-row">
        {open ? (
          <div className="flex shrink-0 flex-col items-center gap-1.5">
            <QrCode value={s.deposit.to} size={160} />
            <p className="max-w-[160px] text-center font-ui text-[10px] tracking-[0.1em] text-ink-dim uppercase">{DEPOSIT.scanHint}</p>
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <CopyRow label={DEPOSIT.sendTo} value={s.deposit.to} />
          <CopyRow label={DEPOSIT.memo} value={s.deposit.memo} warn tag={DEPOSIT.memoRequired} />
          <CopyRow label={DEPOSIT.amount} value={hbarPlain(s.deposit.amount)} shown={`${hbarPlain(s.deposit.amount)} ℏ`} />
          {open ? <p className="font-ui text-[11px] tracking-[0.06em] text-threat uppercase">{DEPOSIT.memoWarning}</p> : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t-2 border-dashed border-line pt-2.5" aria-live="polite">
        {s.state === "awaiting" ? <LED kind="warn" label={DEPOSIT.waiting} /> : null}
        {s.state === "underpaid" ? (
          <LED kind="warn" label={DEPOSIT.underpaid(`${hbarPlain(s.received)} ℏ`, `${hbarPlain(missing.toString())} ℏ`)} />
        ) : null}
        {s.state === "funding" ? <LED kind="money" blink label={s.step ? DEPOSIT.settingUp(s.step.k, s.step.n) : DEPOSIT.funding} /> : null}
        {s.state === "funded" ? <LED kind="safe" label={DEPOSIT.funded} /> : null}
        {s.state === "failed" ? <LED kind="offline" label={DEPOSIT.failed} /> : null}
        {s.state === "expired" ? <LED kind="idle" label={DEPOSIT.expired} /> : null}
        {open && left !== null ? (
          <span className="flex items-center gap-2 font-ui text-[11px] tracking-[0.1em] text-ink-dim uppercase">
            {DEPOSIT.expiresIn}
            <Digits value={mmss(left)} size="md" tone={left < 300 ? "warn" : "money"} />
          </span>
        ) : null}
      </div>

      {s.state === "failed" ? <p className="mt-2 font-ui text-[11px] tracking-[0.06em] text-ink-dim uppercase">{DEPOSIT.failedHint}</p> : null}
      {s.state === "expired" ? (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 font-ui text-[11px] tracking-[0.06em] text-ink-dim uppercase">{DEPOSIT.expiredHint}</p>
          <PixelButton variant="money" onClick={renew} disabled={renewing === "busy"}>
            {renewing === "busy" ? DEPOSIT.renewing : DEPOSIT.newWindow}
          </PixelButton>
          {renewing === "failed" ? <p className="basis-full font-ui text-[11px] tracking-[0.06em] text-threat uppercase">{DEPOSIT.renewFailed}</p> : null}
        </div>
      ) : null}
      {s.note && /^late:/m.test(s.note) ? <p className="mt-2 font-ui text-[11px] tracking-[0.06em] text-warn uppercase">{DEPOSIT.lateNote}</p> : null}
      {s.note && /refund manually/.test(s.note) ? <p className="mt-2 font-ui text-[11px] tracking-[0.06em] text-warn uppercase">{DEPOSIT.refundNote}</p> : null}
    </PixelPanel>
  );
}
