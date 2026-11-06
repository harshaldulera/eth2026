import { Check, Cloud, DoorClosed, DoorOpen, Moon, Plug, Shield } from "lucide-react";
import type { TransportKind, VaultState } from "@/lib/types";
import { SETUP_STEPS } from "@/lib/money/vault";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const STATE: Record<VaultState, { tone: "ward" | "gold" | "neutral" | "parchment" | "stub"; label: string; Icon?: typeof Shield }> = {
  created: { tone: "stub", label: "Created" },
  connected: { tone: "stub", label: "Connected", Icon: Plug },
  verified: { tone: "parchment", label: "Verified", Icon: Check },
  funded: { tone: "parchment", label: "Funded" },
  guarding: { tone: "ward", label: "Guarding", Icon: Shield },
  dormant: { tone: "neutral", label: "Dormant", Icon: Moon },
  broken: { tone: "gold", label: "Broken", Icon: DoorOpen },
  closed: { tone: "neutral", label: "Closed", Icon: DoorClosed },
};

/**
 * Vault lifecycle badge (props only). Only `guarding` takes sieges.
 *
 * @example <VaultStateBadge state={castle.vaultState} />
 */
export function VaultStateBadge({ state, className }: { state: VaultState; className?: string }) {
  const s = STATE[state] ?? STATE.created;
  const Icon = s.Icon;
  return (
    <Badge tone={s.tone} className={className} title={state === "guarding" ? "Taking sieges" : "Not taking sieges"}>
      {Icon ? <Icon aria-hidden /> : null}
      {s.label}
    </Badge>
  );
}

/**
 * How the guardian is reached: our hosted runtime, or the Castellan's own agent through the SDK.
 *
 * @example <TransportBadge transport="sdk" />
 */
export function TransportBadge({ transport, className }: { transport: TransportKind; className?: string }) {
  return transport === "sdk" ? (
    <Badge tone="parchment" className={className} title="The Castellan's own agent, guarded through the @siege/guard SDK">
      <Plug aria-hidden /> Your agent · SDK
    </Badge>
  ) : (
    <Badge tone="neutral" className={className} title="Guardian runs on the arena's hosted runtime">
      <Cloud aria-hidden /> Hosted
    </Badge>
  );
}

/**
 * The tool call that counts as a break, in mono.
 *
 * @example <ProtectedTool tool="issue_refund" />  // "protects issue_refund"
 */
export function ProtectedTool({ tool, className }: { tool: string; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 text-[11px] text-stone", className)} title="A call to this tool counts as a break">
      protects <code className="truncate rounded bg-white/5 px-1 py-px font-mono text-parchment/85">{tool}</code>
    </span>
  );
}

/**
 * Small step indicator for a vault still being set up (created → … → funded → guarding).
 *
 * @example <VaultSetupSteps transport="sdk" state="connected" />
 */
export function VaultSetupSteps({ transport, state, className }: { transport: TransportKind; state: VaultState; className?: string }) {
  const steps = [...SETUP_STEPS[transport], "guarding" as const];
  const at = steps.indexOf(state);
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[11px] text-stone", className)}>
      <span className="inline-flex items-center gap-1" aria-hidden>
        {steps.map((s, i) => (
          <span key={s} className={cn("h-1 w-3 rounded-full", i <= at ? "bg-parchment/70" : "bg-arena-line")} />
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
