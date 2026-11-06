"use client";

import { useId, useState } from "react";
import { api, ApiError, type ZgFailReason } from "@/lib/api/client";
import { ZG } from "@/lib/vocab";
import { cn } from "@/lib/utils";
import { LED } from "@/components/pixel/led";
import { PixelButton } from "@/components/pixel/button";

/** What the parent form gets once the key checks out. `key` goes to the server in the publish / unit call. */
export type ZgConnectResult = { kind: "mk" | "sk"; balance?: string; models?: string[]; model?: string; mock?: boolean; key: string };

export type ZgConnectProps = {
  /** Field label (defaults to "0G KEY"). */
  label?: string;
  onConnected: (result: ZgConnectResult) => void;
  /** The owner cleared or changed the key: the parent forgets the previous result. */
  onCleared?: () => void;
  /** One line, no helper copy (unit card, compact forms). */
  compact?: boolean;
  className?: string;
};

type Problem = ZgFailReason | "bad_format" | "rate_limited";

const field =
  "min-h-11 w-full border-2 border-line bg-bg px-2.5 font-term text-[20px] leading-none text-ink focus:border-accent focus:outline-none";

/**
 * CONNECT 0G (shared by publish, plug-in and new-unit): paste a key from pc.0g.ai, probe it with
 * POST /api/zg/validate (never stored or minted there), show the LED with balance and model.
 *
 * @example <ZgConnect onConnected={(r) => setZgKey(r.key)} />
 */
export function ZgConnect({ label, onConnected, onCleared, compact, className }: ZgConnectProps) {
  const id = useId();
  const [key, setKey] = useState("");
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [ok, setOk] = useState<ZgConnectResult | null>(null);

  async function connect() {
    const k = key.trim();
    if (!/^(mk|sk)-\S+$/.test(k)) return setProblem("bad_format");
    setBusy(true);
    setProblem(null);
    try {
      const r = await api.zgValidate(k);
      if (!r.ok) return setProblem(r.reason);
      const result: ZgConnectResult = { kind: r.kind, balance: r.balance, models: r.models, model: r.model, mock: r.mock, key: k };
      setOk(result);
      onConnected(result);
    } catch (e) {
      setProblem(e instanceof ApiError && e.status === 429 ? "rate_limited" : "unreachable");
    } finally {
      setBusy(false);
    }
  }

  function change() {
    setOk(null);
    setKey("");
    setProblem(null);
    onCleared?.();
  }

  if (ok) {
    return (
      <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", className)}>
        <LED kind="safe" className="max-w-full whitespace-normal leading-snug" label={ZG.connected(ok.kind === "mk" ? (ok.balance ?? "?") : undefined, ok.model)} />
        {ok.mock ? <LED kind="stub" label={ZG.mockNote} /> : null}
        <PixelButton size="sm" variant="ghost" onClick={change}>
          {ZG.change}
        </PixelButton>
        {ok.kind === "sk" && !compact ? <p className="w-full text-[12px] text-ink-dim">{ZG.skNote}</p> : null}
      </div>
    );
  }

  return (
    <div className={cn("space-y-2", className)}>
      <label htmlFor={id} className="block font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">
        {label ?? ZG.fieldLabel}
      </label>
      <div className="flex gap-2">
        <input
          id={id}
          type={shown ? "text" : "password"}
          autoComplete="off"
          spellCheck={false}
          value={key}
          placeholder={ZG.placeholder}
          onChange={(e) => {
            setKey(e.target.value);
            setProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void connect();
            }
          }}
          className={cn(field, "min-w-0 flex-1", problem && "border-threat")}
        />
        <PixelButton type="button" size="sm" variant="ghost" onClick={() => setShown((s) => !s)} aria-pressed={shown}>
          {shown ? ZG.hide : ZG.show}
        </PixelButton>
        <PixelButton type="button" variant="money" disabled={busy || !key.trim()} onClick={() => void connect()}>
          {busy ? ZG.checking : ZG.connect}
        </PixelButton>
      </div>
      {problem ? (
        <p role="alert" className="text-[12px] text-threat">
          {ZG.reasons[problem]}
        </p>
      ) : null}
      {compact ? null : (
        <p className="text-[12px] leading-snug text-ink-dim">
          {ZG.help}{" "}
          <a href={ZG.pcUrl} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
            {ZG.openPc}
          </a>
        </p>
      )}
    </div>
  );
}
