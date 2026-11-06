"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { useCalmMotion } from "@/lib/hooks/usePrefs";
import { PixelPanel } from "@/components/pixel/panel";
import { Sprite } from "@/components/pixel/sprite";
import { cn } from "@/lib/utils";
import { QrCode } from "./qr-code";

const BASE_KEY = "siege.phoneBase";
const EVT = "siege:phone-base";

function subscribe(cb: () => void) {
  window.addEventListener(EVT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(EVT, cb);
    window.removeEventListener("storage", cb);
  };
}
function readBase(): string {
  try {
    return localStorage.getItem(BASE_KEY) ?? "";
  } catch {
    return "";
  }
}
function writeBase(v: string) {
  try {
    if (v) localStorage.setItem(BASE_KEY, v);
    else localStorage.removeItem(BASE_KEY);
  } catch {
    /* private mode: ignore */
  }
  window.dispatchEvent(new Event(EVT));
}

const noopSubscribe = () => () => {};

/**
 * The owner's pager link: QR to /raider/approvals. The base URL defaults to this page's origin and
 * can be overridden (a phone cannot open "localhost" — use the laptop's LAN address). `pulse`
 * (any changing value, e.g. a counter bumped on each cap hit) flashes the QR frame once.
 *
 * @example <PhoneApprovalsCard ownerKeyHint={config.ownerKeyHint} pending={2} pulse={radioCount} />
 */
export function PhoneApprovalsCard({ ownerKeyHint, pending = 0, pulse }: { ownerKeyHint?: boolean; pending?: number; pulse?: number }) {
  const origin = useSyncExternalStore(noopSubscribe, () => window.location.origin, () => "");
  const override = useSyncExternalStore(subscribe, readBase, () => "");
  const calm = useCalmMotion();
  const base = (override || origin).replace(/\/+$/, "");
  const url = `${base}/raider/approvals`;
  const local = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);

  return (
    <PixelPanel
      title="Owner pager"
      icon={<Sprite name="pager" scale={1} animate={pending > 0} />}
      tone={pending ? "warn" : "default"}
      action={pending ? <span className="animate-blink bg-warn px-1.5 py-0.5 font-ui text-[10px] text-bg">{pending} WAITING</span> : null}
      bodyClassName="flex flex-col items-center gap-4 p-4"
    >
      <motion.div
        key={pulse ?? 0}
        initial={pulse && !calm ? { scale: 1.06 } : false}
        animate={{ scale: 1 }}
        transition={{ type: "spring", stiffness: 500, damping: 14 }}
        className={cn("p-2 bg-raised px-frame", pending ? "[--frame:var(--color-warn)]" : "")}
      >
        {base ? <QrCode value={url} size={176} /> : <div className="size-[176px] shimmer" aria-hidden />}
      </motion.div>
      <p className="text-center text-sm text-ink-dim">Scan with the owner&apos;s phone. A cap hit lands there; the unit waits until you DENY or APPROVE.</p>
      <Link href="/raider/approvals" className="max-w-full truncate font-mono text-xs text-ink underline decoration-line decoration-2 underline-offset-4 hover:text-accent">
        {url || "/raider/approvals"}
      </Link>
      {local ? (
        <div className="w-full border-2 border-dashed border-warn/60 p-2.5 text-xs text-ink">
          <p className="font-ui text-[11px] tracking-[0.1em] text-warn uppercase">⚠ Phones can&apos;t open localhost</p>
          <p className="mt-1 text-ink-dim">Enter this laptop&apos;s LAN address (the dev server listens on 0.0.0.0):</p>
        </div>
      ) : null}
      <label className="w-full">
        <span className="mb-1 block font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">Phone URL base</span>
        <input
          value={override}
          onChange={(e) => writeBase(e.target.value.trim())}
          placeholder={origin || "http://192.168.1.20:3000"}
          inputMode="url"
          className="min-h-10 w-full border-2 border-line bg-bg px-2.5 font-mono text-xs text-ink placeholder:text-ink-dim/70 focus:border-accent focus:outline-none"
        />
      </label>
      {ownerKeyHint ? (
        <p className="w-full text-xs text-ink-dim">
          Dev owner key <code className="font-mono text-ink">siege-demo-owner</code> (prefilled on the phone)
        </p>
      ) : null}
    </PixelPanel>
  );
}
