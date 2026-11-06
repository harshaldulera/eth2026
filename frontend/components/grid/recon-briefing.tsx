"use client";

import { visitorId } from "@/lib/hooks/useVisitor";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import type { Castle } from "@/lib/types";
import { ApiError, api, describeError, isNotGuarding } from "@/lib/api/client";
import { formatAmount } from "@/lib/money/format";
import { vaultStateOf } from "@/lib/money/vault";
import { BUTTONS, EMPTY, TOASTS, UNITS, tierLevel } from "@/lib/vocab";
import { useHasOperatorKeys } from "@/lib/agents/use-operator-keys";
import { Dialog } from "@/components/pixel/dialog";
import { PixelButton, pixelButtonVariants } from "@/components/pixel/button";
import { Sprite } from "@/components/pixel/sprite";
import { playCue } from "@/components/pixel/sfx-link";
import { cn } from "@/lib/utils";
import { GuardPost } from "./guard-post";
import { vaultPath } from "@/lib/vault-path";

/** The QR's target: the lowest-tier guarding vault (cheapest fee, then smallest pot, breaks ties). */
export function reconTarget<T extends Castle>(castles: readonly T[]): T | undefined {
  return [...castles]
    .filter((c) => vaultStateOf(c) === "guarding")
    .sort(
      (a, b) =>
        tierLevel(a.tier, a.transport) - tierLevel(b.tier, b.transport) ||
        Number(BigInt(a.fee) - BigInt(b.fee)) ||
        Number(BigInt(a.pot) - BigInt(b.pot)),
    )[0];
}

/** True when a start failed because today's free recon is spent. */
export function isReconUsed(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 429 || e.code === "free_used");
}

/**
 * The QR landing (`/?recon=1`): YOU ARE AN OPERATOR, one sentence, one button. Tap → free recon on
 * the lowest-tier guarding vault → the Op room. A spent recon flips the card to RECON USED TODAY
 * with the paid op one tap away: the vault page's FUND YOUR OPERATOR ACCOUNT flow (`?fund=1`), since
 * every paid op is paid from the visitor's own account. Bottom sheet on phones, centred card on desktop.
 *
 * @example <ReconBriefing open={params.get("recon") === "1"} castles={guarding} onClose={dropParam} />
 */
export function ReconBriefing({
  open,
  castles,
  loading,
  onClose,
  onLeave,
}: {
  open: boolean;
  castles: readonly Castle[];
  loading?: boolean;
  /** "or pick a vault", Esc, backdrop. */
  onClose: () => void;
  /** Called right before navigating to the Op room (drop `?recon=1` from history). */
  onLeave?: () => void;
}) {
  const router = useRouter();
  const target = reconTarget(castles);
  const [busy, setBusy] = useState(false);
  const [used, setUsed] = useState(false);
  // An operator key in this browser = an account of their own to pay from (no fund step needed).
  const hasAccount = useHasOperatorKeys();

  const primary = useRef<HTMLButtonElement>(null);

  // The dialog focuses its first control (the close ×) on open; put focus on the one action instead.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => primary.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open, target?.id]);

  // Routes stay mounted (hidden) after navigation: reset the spinner when this one is hidden.
  useLayoutEffect(() => () => setBusy(false), []);

  async function run() {
    if (!target) return;
    setBusy(true);
    try {
      const res = await api.playRecon({ castleId: target.id, visitor: visitorId() });
      playCue("recon_start");
      toast.success(TOASTS.reconStarted.title, { description: TOASTS.reconStarted.body });
      onLeave?.();
      router.push(`/siege/${res.siegeId}?go=1`);
    } catch (e) {
      setBusy(false);
      if (isReconUsed(e)) {
        playCue("deny");
        setUsed(true);
      } else if (isNotGuarding(e)) toast.error("NOT TAKING OPS", { description: describeError(e) });
      else toast.error("RECON DIDN'T START", { description: describeError(e) });
    }
  }

  const fee = target ? formatAmount(target.fee, target.asset) : "";
  return (
    <Dialog
      open={open}
      onClose={onClose}
      tone={used ? "warn" : "accent"}
      title={used ? "RECON USED TODAY" : "YOU ARE AN OPERATOR"}
      className="max-sm:mb-0 max-sm:w-full max-sm:max-w-none sm:w-[min(92vw,34rem)]"
      actions={
        <button type="button" onClick={onClose} className="mr-auto font-ui text-[11px] tracking-[0.08em] text-ink-dim uppercase underline decoration-line underline-offset-4 hover:text-ink">
          {BUTTONS.pickVault}
        </button>
      }
    >
      <div className="flex gap-4">
        <div className="hidden shrink-0 flex-col items-center gap-2 sm:flex" aria-hidden>
          <Sprite name="operator.idle" scale={4} animate />
          <span className="font-ui text-[10px] tracking-[0.14em] text-ink-dim">YOU</span>
        </div>
        <div className="min-w-0 flex-1 space-y-4">
          {used ? (
            <p className="text-[15px] leading-relaxed text-ink">
              Today&apos;s free recon is spent. Fund your own account and pay {target ? <span className="text-money">{fee}</span> : "the fee"} from it to run a
              real op: if you talk the guard into it, the vault pays you.
            </p>
          ) : (
            <p className="text-[15px] leading-relaxed text-ink">
              AI guards hold vaults of test HBAR. You get <b className="font-semibold">5 messages</b> to talk one into unlocking. Recon is free, once a day, and{" "}
              <span className="text-warn">never pays out</span>.
            </p>
          )}

          {target ? (
            <div className="flex items-center gap-3 bg-bg/60 p-2 shadow-[inset_0_0_0_2px_var(--color-line)]">
              <GuardPost castle={target} scale={2} />
              <div className="min-w-0">
                <p className="truncate font-ui text-xs tracking-[0.04em] text-ink uppercase">{target.name}</p>
                <p className="truncate text-xs text-ink-dim">{target.guardianName}</p>
                <p className="mt-1 font-term text-base leading-none text-ink-dim">
                  pot <span className="text-money">{formatAmount(target.pot, target.asset, { minDecimals: 2, maxDecimals: 2 })}</span>
                </p>
              </div>
            </div>
          ) : !loading ? (
            <p className="font-ui text-xs tracking-[0.08em] text-warn uppercase">{EMPTY.noVaultTaking.title}</p>
          ) : null}

          {used && target ? (
            <Link
              // Every paid op is paid from your own account: with one in this browser the vault page's RUN OP
              // pays from it; without one, the vault page opens FUND YOUR OPERATOR ACCOUNT (`?fund=1`).
              href={hasAccount ? `${vaultPath(target.id)}` : `${vaultPath(target.id)}?fund=1`}
              onClick={() => playCue("ui_blip")}
              className={cn(pixelButtonVariants({ variant: "money", size: "xl" }), "w-full")}
            >
              {hasAccount ? UNITS.reconUsedPay(fee, target.name) : UNITS.reconUsedFund(target.name)}
            </Link>
          ) : (
            <PixelButton
              variant="safe"
              size="xl"
              className="w-full"
              cue={null}
              disabled={!target || busy}
              ref={primary}
              onClick={() => void run()}
            >
              {busy ? "STARTING RECON…" : target ? BUTTONS.runRecon(target.name) : loading ? "FINDING A VAULT…" : "NO VAULT TO RECON"}
            </PixelButton>
          )}
          {/* J5: the developer door */}
          <Link href="/docs" onClick={onLeave} className="block text-center font-ui text-[11px] tracking-[0.08em] text-ink-dim uppercase underline decoration-line underline-offset-4 hover:text-accent">
            {BUTTONS.bringAgent}
          </Link>
        </div>
      </div>
    </Dialog>
  );
}
