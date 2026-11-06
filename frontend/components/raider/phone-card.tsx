"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { KeyRound, Smartphone, TriangleAlert } from "lucide-react";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
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
 * "Approve from your phone": QR to /raider/approvals. The base URL defaults to this page's origin
 * and can be overridden (a phone cannot open "localhost" — use the laptop's LAN address).
 *
 * @example <PhoneApprovalsCard ownerKeyHint={config.ownerKeyHint} pending={2} />
 */
export function PhoneApprovalsCard({ ownerKeyHint, pending = 0 }: { ownerKeyHint?: boolean; pending?: number }) {
  const origin = useSyncExternalStore(noopSubscribe, () => window.location.origin, () => "");
  const override = useSyncExternalStore(subscribe, readBase, () => "");
  const base = (override || origin).replace(/\/+$/, "");
  const url = `${base}/raider/approvals`;
  const local = /\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(base);

  return (
    <Card>
      <CardHeader
        title="Approve from your phone"
        icon={<Smartphone />}
        action={pending ? <span className="tabular rounded-full bg-gold px-2 py-0.5 text-[11px] font-semibold text-arena-bg">{pending} waiting</span> : null}
      />
      <CardBody className="flex flex-col items-center gap-4">
        {base ? <QrCode value={url} size={184} /> : <div className="size-[184px] rounded-xl bg-arena-line/40" aria-hidden />}
        <p className="text-center text-sm text-stone">
          Scan to open the owner screen. When an agent hits a cap it pauses here until you approve or deny.
        </p>
        <Link href="/raider/approvals" className="max-w-full truncate font-mono text-xs text-parchment/80 underline decoration-arena-line underline-offset-4 hover:text-gold">
          {url || "/raider/approvals"}
        </Link>
        {local ? (
          <div className="w-full rounded-lg border border-gold/30 bg-gold/[0.05] p-2.5 text-xs text-parchment/85">
            <p className="flex items-center gap-1.5 font-medium text-gold">
              <TriangleAlert className="size-3.5" /> Phones can&apos;t open localhost
            </p>
            <p className="mt-1 text-stone">Enter this laptop&apos;s LAN address (dev server listens on 0.0.0.0):</p>
          </div>
        ) : null}
        <label className="w-full text-xs text-stone">
          Phone URL base
          <input
            value={override}
            onChange={(e) => writeBase(e.target.value.trim())}
            placeholder={origin || "http://192.168.1.20:3000"}
            inputMode="url"
            className="mt-1 h-9 w-full rounded-lg border border-arena-line bg-arena-bg/60 px-2.5 font-mono text-xs text-parchment placeholder:text-stone/60 focus:border-gold/50 focus:outline-none"
          />
        </label>
        {ownerKeyHint ? (
          <p className="flex w-full items-center gap-1.5 text-xs text-stone">
            <KeyRound className="size-3.5 shrink-0 text-gold" aria-hidden />
            Dev owner key: <code className="font-mono text-parchment">siege-demo-owner</code> (prefilled on the phone)
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
