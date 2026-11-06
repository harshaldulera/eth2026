import type { TransportKind, VaultState } from "@/lib/types";
import { SETUP_STEPS } from "@/lib/money/vault";
import { LED as LED_TEXT } from "@/lib/vocab";
import { LED, type LedKind } from "@/components/pixel/led";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/** Setup progress `k/n` for a vault that is not guarding yet (null otherwise). */
export function setupProgress(transport: TransportKind, state: VaultState): { k: number; n: number } | null {
  const steps = [...SETUP_STEPS[transport], "guarding" as const];
  const at = steps.indexOf(state);
  if (state === "guarding" || at < 0) return null;
  return { k: at + 1, n: steps.length };
}

/** The state light's kind and words: `GUARDING`, `OFFLINE`, `BREACHED`, `CLOSED`, `SETTING UP k/n`. */
export function vaultStateLed(state: VaultState, transport: TransportKind = "hosted"): { kind: LedKind; label: string; blink?: boolean } {
  switch (state) {
    case "guarding":
      return { kind: "safe", label: LED_TEXT.guarding };
    case "dormant":
      return { kind: "offline", label: LED_TEXT.offline() };
    case "broken":
      return { kind: "money", label: LED_TEXT.breached };
    case "closed":
      return { kind: "idle", label: LED_TEXT.closed };
    default: {
      const p = setupProgress(transport, state);
      return { kind: "warn", label: p ? LED_TEXT.settingUp(p.k, p.n) : state.toUpperCase(), blink: false };
    }
  }
}

/**
 * Vault lifecycle light (props only). Only `guarding` takes ops.
 *
 * @example <VaultStateBadge state={castle.vaultState} />
 */
export function VaultStateBadge({ state, transport, className }: { state: VaultState; transport?: TransportKind; className?: string }) {
  const s = vaultStateLed(state, transport);
  return <LED kind={s.kind} label={s.label} blink={s.blink} className={className} title={state === "guarding" ? "Taking ops" : "Not taking ops"} />;
}

/**
 * How the guard is reached: the arena's hosted runtime, or the owner's own agent through the SDK.
 *
 * @example <TransportBadge transport="sdk" />
 */
export function TransportBadge({ transport, className }: { transport: TransportKind; className?: string }) {
  return transport === "sdk" ? (
    <Badge tone="parchment" className={className} title="The owner's own agent, guarded through the @siege/guard SDK">
      PRODUCTION · SDK
    </Badge>
  ) : (
    <Badge tone="neutral" className={className} title="The guard runs on the arena's hosted runtime">
      HOSTED
    </Badge>
  );
}

/**
 * The tool call that counts as a breach, in mono.
 *
 * @example <ProtectedTool tool="issue_refund" />  // "PROTECTS issue_refund"
 */
export function ProtectedTool({ tool, className }: { tool: string; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 font-ui text-[10px] tracking-[0.1em] text-ink-dim uppercase", className)} title="A call to this tool counts as a breach">
      protects <code className="truncate font-mono text-xs tracking-normal text-ink normal-case">{tool}</code>
    </span>
  );
}

/**
 * Step indicator for a vault still being set up (created → … → funded → guarding).
 *
 * @example <VaultSetupSteps transport="sdk" state="connected" />
 */
export function VaultSetupSteps({ transport, state, className }: { transport: TransportKind; state: VaultState; className?: string }) {
  const steps = [...SETUP_STEPS[transport], "guarding" as const];
  const at = steps.indexOf(state);
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-ui text-[10px] tracking-[0.1em] text-ink-dim uppercase", className)}>
      <span className="inline-flex items-center gap-[3px]" aria-hidden>
        {steps.map((s, i) => (
          <span key={s} className={cn("h-2 w-3", i <= at ? "bg-warn" : "shadow-[inset_0_0_0_1px_var(--color-line)]")} />
        ))}
      </span>
      <span className="tabular">
        step {Math.max(1, at + 1)}/{steps.length}
      </span>
      <span className="sr-only">
        {state}, {steps.length - 1 - Math.max(0, at)} steps until guarding
      </span>
    </span>
  );
}
