"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Cloud, Plug } from "lucide-react";
import { ApiError, api, type DepositStatus, type PublishDeposit } from "@/lib/api/client";
import { PUBLISH_VOICES } from "@/lib/publish/schema";
import {
  buildInput,
  exampleDraft,
  feeSplit,
  stepErrors,
  stepOk,
  validateDraft,
  DAY_CHOICES,
  type Draft,
  type Transport,
} from "@/lib/publish/form";
import { rememberOwner, usePublishDraft, usePublishResult, type StoredResult } from "@/lib/publish/store";
import { BUTTONS, MONEY, PUBLISH, VOCAB, ZG } from "@/lib/vocab";
import { cn } from "@/lib/utils";
import { DepositPanel } from "@/components/money/deposit-panel";
import { ZgConnect, type ZgConnectResult } from "@/components/money/zg-connect";
import { PlugInAgent } from "@/components/owner/plug-in-agent";
import { Field, StepChips, StepNav, TextInput, VoicePicker } from "@/components/publish/form-bits";
import { CopyField } from "@/components/publish/copy-field";
import { LiveCard, useOrigin } from "@/components/publish/live-card";
import { ToolEditor } from "@/components/publish/tool-editor";
import { LED } from "@/components/pixel/led";
import { PixelButton, pixelButtonVariants } from "@/components/pixel/button";
import { PixelPanel } from "@/components/pixel/panel";
import { playCue } from "@/components/pixel/sfx-link";
import { Loading } from "@/components/ui/state";

const STEPS = [PUBLISH.stepGuard, PUBLISH.stepConnect, PUBLISH.stepMoney, PUBLISH.stepLive] as const;

/** POST /api/castles failure → one line of copy. */
export function publishError(e: unknown): string {
  if (e instanceof ApiError) {
    const base = PUBLISH.errors[e.code ?? ""] ?? PUBLISH.errors.other!;
    return e.status === 0 ? e.message : base;
  }
  return PUBLISH.errors.other!;
}

/** The deposit status the create call implies (so the panel has something before its first poll). */
function initialDeposit(dep: PublishDeposit): DepositStatus {
  return {
    intentId: dep.intentId,
    kind: "vault",
    state: "awaiting",
    received: "0",
    requested: dep.amount,
    payer: null,
    error: null,
    note: null,
    expiresAt: dep.expiresAt,
    deposit: { to: dep.to, memo: dep.memo, amount: dep.amount },
  };
}

/**
 * /publish: put your own agent behind a vault. Pick how it runs (we run it / you plug it in), then
 * GUARD -> CONNECT 0G -> MONEY -> GO LIVE, then the deposit panel and the live card.
 */
export function PublishView() {
  const params = useSearchParams();
  const { draft, patch, reset, ready } = usePublishDraft();
  const { result, save } = usePublishResult();
  const [zg, setZg] = useState<ZgConnectResult | null>(null);
  const [tried, setTried] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const origin = useOrigin();

  const preset = params.get("mode");
  const transport: Transport | null = draft.transport ?? (preset === "hosted" || preset === "sdk" ? preset : null);
  const d: Draft = { ...draft, transport };
  // the 0G key is never stored: after a refresh, anything past CONNECT 0G sends you back to it
  const step = transport && !zg && d.step > 1 ? 1 : d.step;
  const zgKey = zg?.key ?? "";

  if (!ready) return <Loading label="Opening the publisher…" />;

  if (result) {
    return (
      <Shell>
        <Published result={result} save={save} origin={origin} onAnother={() => save(null)} />
      </Shell>
    );
  }

  if (!transport) {
    return (
      <Shell>
        <p className="text-[13px] text-ink-dim">{PUBLISH.chooseHint}</p>
        <div className="grid gap-4 md:grid-cols-2">
          <ModeCard
            icon={<Cloud />}
            tag={PUBLISH.hostedTag}
            title={PUBLISH.hostedTitle}
            body={PUBLISH.hostedBody}
            onClick={() => patch({ transport: "hosted", step: 0 })}
            tone="money"
          />
          <ModeCard icon={<Plug />} tag={PUBLISH.sdkTag} title={PUBLISH.sdkTitle} body={PUBLISH.sdkBody} onClick={() => patch({ transport: "sdk", step: 0 })} tone="accent" />
        </div>
      </Shell>
    );
  }

  const errs = stepErrors(d, step, zgKey);
  const show = (i: number) => Boolean(tried[i]);
  const goto = (i: number) => patch({ step: i, transport });
  const next = () => {
    if (!stepOk(d, step, zgKey)) {
      setTried((t) => ({ ...t, [step]: true }));
      playCue("ui_blip");
      return;
    }
    goto(step + 1);
  };
  const fe = (k: string) => (show(step) ? errs.fields[k] : undefined);

  async function submit() {
    const all = validateDraft(d, zgKey);
    const bad = (Object.keys(all.fields).length || Object.keys(all.tools).length) > 0;
    if (bad || !zg) {
      const first = [0, 1, 2].find((i) => !stepOk(d, i, zgKey)) ?? 0;
      setTried((t) => ({ ...t, [first]: true }));
      patch({ step: first, transport });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const res = await api.publishCastle(buildInput(d, zgKey));
      rememberOwner(res.castleId);
      if (res.transport === "hosted") {
        save({ castleId: res.castleId, transport: "hosted", shareUrl: res.shareUrl, ownerKey: res.ownerKey, deposit: res.deposit, live: res.state === "funded" });
      } else {
        save({ castleId: res.castleId, transport: "sdk", shareUrl: res.shareUrl, ownerKey: res.ownerKey, guardKey: res.guardKey, live: false });
      }
      reset();
      setZg(null);
      setTried({});
    } catch (e) {
      setProblem(publishError(e));
    } finally {
      setBusy(false);
    }
  }

  const hosted = transport === "hosted";
  const split = feeSplit(d.fee);

  return (
    <Shell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StepChips labels={STEPS} step={step} onGo={goto} />
        <p className="font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">{PUBLISH.stepOf(step + 1, STEPS.length)}</p>
      </div>

      {step === 0 ? (
        <PixelPanel title={hosted ? PUBLISH.hostedTitle : PUBLISH.sdkTitle} tone={hosted ? "money" : "accent"} bodyClassName="space-y-5 p-4">
          {hosted ? (
            <div className="flex flex-wrap items-center gap-3 border-2 border-dashed border-line bg-bg/40 px-3 py-2">
              <p className="min-w-0 flex-1 text-[12px] leading-snug text-ink-dim">{PUBLISH.fillExampleHint}</p>
              <PixelButton size="sm" variant="outline" onClick={() => patch({ ...exampleDraft(), transport, step: 0 })}>
                {PUBLISH.fillExample}
              </PixelButton>
            </div>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={PUBLISH.vaultName} error={fe("name")}>
              <TextInput value={d.name} onChange={(v) => patch({ name: v })} placeholder={PUBLISH.vaultNamePlaceholder} invalid={Boolean(fe("name"))} maxLength={40} />
            </Field>
            <Field label={PUBLISH.guardName} error={fe("guardName")}>
              <TextInput value={d.guardName} onChange={(v) => patch({ guardName: v })} placeholder={PUBLISH.guardNamePlaceholder} invalid={Boolean(fe("guardName"))} maxLength={40} />
            </Field>
          </div>
          <Field label={PUBLISH.blurb} error={fe("blurb")}>
            <TextInput value={d.blurb} onChange={(v) => patch({ blurb: v })} placeholder={PUBLISH.blurbPlaceholder} invalid={Boolean(fe("blurb"))} maxLength={160} />
          </Field>

          {hosted ? (
            <>
              <div>
                <span className="mb-1 block font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">{PUBLISH.voice}</span>
                <VoicePicker value={d.voice} onChange={(v) => patch({ voice: v })} voices={PUBLISH_VOICES} />
                <p className="mt-1.5 text-[12px] text-ink-dim">{PUBLISH.voiceHint}</p>
              </div>
              <Field label={PUBLISH.orders} hint={PUBLISH.ordersHint} error={fe("orders")}>
                <textarea
                  value={d.orders}
                  onChange={(e) => patch({ orders: e.target.value })}
                  rows={8}
                  maxLength={8000}
                  spellCheck={false}
                  placeholder={PUBLISH.ordersPlaceholder}
                  className={cn("w-full resize-y border-2 border-line bg-bg px-2.5 py-2 font-mono text-[13px] leading-relaxed text-ink focus:border-accent focus:outline-none", fe("orders") && "border-threat")}
                />
                <span className="mt-1 block text-right font-ui text-[10px] tracking-[0.1em] text-ink-dim">{PUBLISH.ordersCount(d.orders.length)}</span>
              </Field>
              <ToolEditor
                tools={d.tools}
                onChange={(tools) => patch({ tools })}
                errors={show(0) ? errs.tools : {}}
                groupError={fe("tools") ?? fe("protectedTool")}
              />
            </>
          ) : (
            <Field label={PUBLISH.sdkProtected} hint={PUBLISH.sdkProtectedHint} error={fe("protectedTool")}>
              <TextInput value={d.protectedTool} onChange={(v) => patch({ protectedTool: v })} placeholder={PUBLISH.sdkProtectedPlaceholder} invalid={Boolean(fe("protectedTool"))} autoCapitalize="off" maxLength={64} />
            </Field>
          )}

          <StepNav onBack={() => patch({ transport: null, step: 0 })} backLabel={PUBLISH.changeMode} onNext={next} />
          <p className="font-ui text-[10px] tracking-[0.1em] text-ink-dim uppercase">{PUBLISH.draftSaved}</p>
        </PixelPanel>
      ) : null}

      {step === 1 ? (
        <PixelPanel title={PUBLISH.connectTitle} tone="accent" bodyClassName="space-y-4 p-4">
          <p className="text-[14px] leading-relaxed text-ink-dim">{PUBLISH.connectBody}</p>
          {zg ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <LED kind="safe" className="max-w-full whitespace-normal" label={ZG.connected(zg.kind === "mk" ? (zg.balance ?? "?") : undefined, zg.model)} />
              {zg.mock ? <LED kind="stub" label={ZG.mockNote} /> : null}
              <PixelButton size="sm" variant="ghost" onClick={() => setZg(null)}>
                {ZG.change}
              </PixelButton>
            </div>
          ) : (
            <ZgConnect onConnected={setZg} onCleared={() => setZg(null)} />
          )}
          {!zg && show(1) ? (
            <p role="alert" className="text-[12px] text-threat">
              {PUBLISH.connectRequired}
            </p>
          ) : null}
          <p className="text-[12px] leading-snug text-ink-dim">{PUBLISH.connectKeyNote}</p>
          <StepNav onBack={() => goto(0)} onNext={next} />
        </PixelPanel>
      ) : null}

      {step === 2 ? (
        <PixelPanel title={PUBLISH.moneyTitle} tone="money" bodyClassName="space-y-5 p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={PUBLISH.fee} hint={PUBLISH.feeHint} error={fe("fee")}>
              <TextInput value={d.fee} onChange={(v) => patch({ fee: v })} suffix="ℏ" inputMode="decimal" invalid={Boolean(fe("fee"))} />
            </Field>
            <Field label={PUBLISH.pot} hint={PUBLISH.potHint} error={fe("pot")}>
              <TextInput value={d.pot} onChange={(v) => patch({ pot: v })} suffix="ℏ" inputMode="decimal" invalid={Boolean(fe("pot"))} />
            </Field>
          </div>
          <div>
            <span className="mb-1 block font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">{PUBLISH.days}</span>
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={PUBLISH.days}>
              {DAY_CHOICES.map((n) => (
                <PixelButton key={n} role="radio" aria-checked={d.days === n} pressed={d.days === n} variant="outline" onClick={() => patch({ days: n })}>
                  {PUBLISH.daysChips(n)}
                </PixelButton>
              ))}
            </div>
          </div>
          <Field
            label={hosted ? PUBLISH.payer : PUBLISH.payerRequired}
            hint={hosted ? PUBLISH.payerHintHosted : PUBLISH.payerHint}
            error={fe("payerAccount")}
          >
            <TextInput value={d.payerAccount} onChange={(v) => patch({ payerAccount: v })} placeholder={PUBLISH.payerPlaceholder} invalid={Boolean(fe("payerAccount"))} autoCapitalize="off" />
          </Field>
          {split ? <p className="border-2 border-dashed border-money/50 bg-bg/50 px-3 py-2 font-term text-[19px] leading-tight text-money">{MONEY.ifHolds(split.owner, split.pot, split.arena)}</p> : null}
          <p className="text-[12px] leading-snug text-ink-dim">{PUBLISH.custody}</p>
          <StepNav onBack={() => goto(1)} onNext={next} />
        </PixelPanel>
      ) : null}

      {step === 3 ? (
        <PixelPanel title={PUBLISH.liveTitle} tone="safe" bodyClassName="space-y-4 p-4">
          <Recap d={d} zg={zg} />
          {problem ? (
            <p role="alert" className="border-2 border-threat px-3 py-2 text-[13px] text-threat">
              {problem}
            </p>
          ) : null}
          <StepNav onBack={() => goto(2)}>
            <PixelButton variant="money" size="xl" cue="ui_confirm" disabled={busy} onClick={() => void submit()} className="max-sm:w-full">
              {busy ? PUBLISH.publishing : hosted ? PUBLISH.publish : PUBLISH.publishSdk}
            </PixelButton>
          </StepNav>
        </PixelPanel>
      ) : null}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pt-6 pb-16 sm:px-6 sm:pt-8">
      <header className="mb-5 space-y-2">
        <h1 className="text-2xl tracking-tight text-ink glow sm:text-3xl">{PUBLISH.title}</h1>
        <p className="max-w-xl text-[15px] leading-relaxed text-ink-dim">{PUBLISH.subtitle}</p>
        <Link href="/docs" className="inline-block font-ui text-[11px] tracking-[0.08em] text-ink-dim uppercase underline decoration-line underline-offset-4 hover:text-accent">{BUTTONS.devDocs}</Link>
      </header>
      <div className="space-y-5">{children}</div>
    </div>
  );
}

function ModeCard({ icon, tag, title, body, onClick, tone }: { icon: React.ReactNode; tag: string; title: string; body: string; onClick: () => void; tone: "money" | "accent" }) {
  return (
    <button
      type="button"
      onClick={() => {
        playCue("ui_confirm");
        onClick();
      }}
      className={cn(
        "group relative flex min-h-48 flex-col items-start gap-3 bg-panel p-5 text-left px-frame transition-[filter,transform] hover:brightness-110 active:translate-y-[2px]",
        tone === "money" ? "[--frame:color-mix(in_oklab,var(--color-money)_55%,var(--color-line))]" : "[--frame:color-mix(in_oklab,var(--color-accent)_55%,var(--color-line))]",
      )}
    >
      <span className={cn("grid size-12 place-items-center border-2 [&_svg]:size-6", tone === "money" ? "border-money text-money" : "border-accent text-accent")}>{icon}</span>
      <span className="font-ui text-[10px] tracking-[0.16em] text-ink-dim uppercase">{tag}</span>
      <span className="font-pixel text-[15px] leading-snug tracking-wide text-ink uppercase">{title}</span>
      <span className="text-[14px] leading-relaxed text-ink-dim">{body}</span>
      <span className={cn("mt-auto font-ui text-[12px] tracking-[0.12em]", tone === "money" ? "text-money" : "text-accent")} aria-hidden>
        ▶
      </span>
    </button>
  );
}

function Recap({ d, zg }: { d: Draft; zg: ZgConnectResult | null }) {
  const hosted = d.transport === "hosted";
  const protectedName = hosted ? (d.tools.find((t) => t.protected)?.name ?? "") : d.protectedTool;
  const rows: [string, string][] = [
    [PUBLISH.recap.vault, d.name],
    [PUBLISH.recap.guard, d.guardName],
    ...(hosted ? ([[PUBLISH.recap.voice, PUBLISH.voices[d.voice]?.label ?? d.voice], [PUBLISH.recap.tools, PUBLISH.toolsRecap(d.tools.length)]] as [string, string][]) : []),
    [PUBLISH.recap.protectedTool, protectedName],
    [PUBLISH.recap.fee, `${d.fee} ℏ / ${VOCAB.op.toLowerCase()}`],
    [PUBLISH.recap.pot, `${d.pot} ℏ`],
    [PUBLISH.recap.days, PUBLISH.daysChips(d.days)],
    [PUBLISH.recap.payer, d.payerAccount.trim() || PUBLISH.recap.anyWallet],
    [PUBLISH.recap.zg, zg ? ZG.connected(zg.kind === "mk" ? (zg.balance ?? "?") : undefined, zg.model) : "—"],
  ];
  return (
    <>
      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex min-w-0 items-baseline gap-3 border-b-2 border-dashed border-line pb-1.5">
            <dt className="w-20 shrink-0 font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">{k}</dt>
            <dd className="min-w-0 flex-1 font-term text-[20px] leading-tight break-words text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="text-[12px] leading-snug text-ink-dim">{PUBLISH.custody}</p>
      <p className="font-ui text-[11px] tracking-[0.1em] text-money uppercase">{PUBLISH.youDeposit(d.pot)}</p>
    </>
  );
}

/** After POST /api/castles: the deposit wait (hosted), the live card, or the SDK keys + plug-in panel. */
function Published({ result, save, origin, onAnother }: { result: StoredResult; save: (r: StoredResult | null) => void; origin: string; onAnother: () => void }) {
  const hideKeys = () => save({ ...result, ownerKey: null, guardKey: null });

  if (result.transport === "sdk") {
    return (
      <div className="space-y-5">
        <PixelPanel title={PUBLISH.sdkKeysTitle} tone="warn" bodyClassName="space-y-3 p-4">
          <p className="text-[13px] leading-snug text-warn">{PUBLISH.sdkKeysBody}</p>
          {result.ownerKey ? <CopyField label={PUBLISH.ownerKey} value={result.ownerKey} tone="warn" /> : null}
          {result.guardKey ? <CopyField label={PUBLISH.guardKey} value={result.guardKey} tone="warn" /> : null}
          {result.ownerKey || result.guardKey ? (
            <PixelButton size="sm" variant="outline" onClick={hideKeys}>
              {PUBLISH.ownerKeySaved}
            </PixelButton>
          ) : (
            <p className="text-[12px] text-ink-dim">{PUBLISH.ownerKeyHidden}</p>
          )}
        </PixelPanel>
        <PlugInAgent castleId={result.castleId} guardKey={result.guardKey ?? "YOUR_GUARD_KEY"} baseURL={origin} />
        <div className="flex flex-wrap items-center gap-3">
          <Link href={`/castle/${result.castleId}`} className={pixelButtonVariants({ variant: "safe", size: "lg" })} onClick={() => playCue("ui_blip")}>
            {PUBLISH.openVault}
          </Link>
          <PixelButton variant="ghost" size="sm" onClick={onAnother}>
            {PUBLISH.publishAnother}
          </PixelButton>
        </div>
      </div>
    );
  }

  if (!result.live && result.deposit) {
    return (
      <div className="space-y-5">
        <PixelPanel title={PUBLISH.depositHeading} tone="money" bodyClassName="space-y-3 p-4">
          <p className="text-[13px] leading-snug text-ink-dim">{PUBLISH.depositBody}</p>
          {result.ownerKey ? <CopyField label={PUBLISH.ownerKey} value={result.ownerKey} tone="warn" /> : null}
          <p className="text-[12px] leading-snug text-warn">{PUBLISH.keepKeyOpen}</p>
        </PixelPanel>
        <DepositPanel
          intentId={result.deposit.intentId}
          initial={initialDeposit(result.deposit)}
          onFunded={() => save({ ...result, live: true, deposit: undefined })}
          onRenewed={(deposit) => save({ ...result, deposit })}
        />
      </div>
    );
  }

  return (
    <LiveCard
      castleId={result.castleId}
      shareUrl={result.shareUrl}
      ownerKey={result.ownerKey}
      onKeySaved={() => save({ ...result, ownerKey: null })}
      onAnother={onAnother}
    />
  );
}
