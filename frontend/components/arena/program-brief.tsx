"use client";

import { useId, useRef, useState } from "react";
import type * as React from "react";
import type { ProgramBrief, ProgramTool } from "@/lib/types";
import { PixelPanel } from "@/components/pixel/panel";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<ProgramBrief["kind"], string> = {
  game: "ARENA VAULT",
  business: "BUSINESS AGENT",
  sdk: "EXTERNAL AGENT",
};

type Tab = "target" | "tools" | "rules" | "intel";

/**
 * The vault's public program, like a bug-bounty program page, in four short tabs so an operator can
 * scan it without scrolling: TARGET (what it does, what a breach is), TOOLS (one line each, expand
 * for parameters), RULES (scope) and INTEL (what the owner publishes). The agent's instructions are
 * never shown.
 *
 * @example <ProgramBriefPanel program={detail.program} />
 */
export function ProgramBriefPanel({ program: p, className }: { program: ProgramBrief; className?: string }) {
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "target", label: "Target" },
    { id: "tools", label: "Tools", count: p.tools.length },
    { id: "rules", label: "Rules" },
    ...(p.docs.length ? [{ id: "intel" as const, label: "Intel", count: p.docs.length }] : []),
  ];
  const [tab, setTab] = useState<Tab>("target");
  const base = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKey(e: React.KeyboardEvent, i: number) {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (i + step + tabs.length) % tabs.length;
    setTab(tabs[next].id);
    refs.current[next]?.focus();
  }

  return (
    <PixelPanel
      title="Program"
      tone="accent"
      action={<span className="font-ui text-[10px] tracking-[0.14em] text-accent">{KIND_LABEL[p.kind]}</span>}
      className={className}
      bodyClassName="p-0"
    >
      {/* always visible: who, and the three facts that shape every op */}
      <div className="space-y-2 px-4 pt-3 pb-3">
        {p.org ? (
          <p className="font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">
            Deployed by <span className="text-ink">{p.org}</span>
          </p>
        ) : null}
        <ul className="flex flex-wrap gap-1.5" aria-label="Agent facts">
          <Chip k="Model">{p.model}</Chip>
          <Chip k="Op">{p.messagesPerOp} messages</Chip>
          <Chip k="Memory" title={p.memory}>
            none
          </Chip>
        </ul>
      </div>

      <div role="tablist" aria-label="Program sections" className="flex border-y-2 border-line">
        {tabs.map((t, i) => {
          const on = t.id === tab;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              id={`${base}-tab-${t.id}`}
              role="tab"
              type="button"
              aria-selected={on}
              aria-controls={`${base}-panel-${t.id}`}
              tabIndex={on ? 0 : -1}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => onKey(e, i)}
              className={cn(
                "flex-1 px-2 py-2 font-ui text-[10px] tracking-[0.14em] uppercase transition-colors",
                "border-b-2 -mb-[2px]",
                on ? "border-accent bg-raised text-ink" : "border-transparent text-ink-dim hover:bg-raised hover:text-ink",
              )}
            >
              {t.label}
              {t.count != null ? <span className={cn("ml-1", on ? "text-accent" : "text-ink-dim")}>{t.count}</span> : null}
            </button>
          );
        })}
      </div>

      <div role="tabpanel" id={`${base}-panel-${tab}`} aria-labelledby={`${base}-tab-${tab}`} tabIndex={0} className="p-4 focus-visible:outline-none">
        {tab === "target" ? <TargetTab p={p} onTools={() => setTab("tools")} /> : null}
        {tab === "tools" ? <ToolsTab tools={p.tools} /> : null}
        {tab === "rules" ? <RulesTab p={p} /> : null}
        {tab === "intel" ? <IntelTab docs={p.docs} /> : null}
      </div>

      <p className="border-t-2 border-line px-4 py-2 text-[11px] leading-relaxed text-ink-dim">The agent&apos;s own instructions are private. All of this is what its owner publishes.</p>
    </PixelPanel>
  );
}

// ─── tabs ─────────────────────────────────────────────────────────────────────────────────

function TargetTab({ p, onTools }: { p: ProgramBrief; onTools: () => void }) {
  const prot = p.tools.find((t) => t.protected);
  const reads = p.tools.filter((t) => t.returnsData).length;
  return (
    <div className="space-y-3">
      {/* the identity block shows the brief from sm up; repeat it here only on phones */}
      <p className="text-sm leading-relaxed text-ink sm:hidden">{p.brief}</p>
      <div className="border-2 border-threat bg-bg px-3 py-2.5">
        <p className="font-ui text-[10px] tracking-[0.14em] text-threat uppercase">Win condition</p>
        <p className="mt-1 text-sm leading-relaxed text-ink">{p.breach}</p>
      </div>
      <button type="button" onClick={onTools} className="group flex w-full items-center justify-between gap-3 border-2 border-line bg-bg px-3 py-2 text-left hover:bg-raised">
        <span className="text-sm text-ink">
          {prot ? (
            <>
              Guards <code className="font-mono text-sm text-threat">{prot.name}</code>
            </>
          ) : null}
          {reads ? <span className="text-ink-dim"> · reads from {reads} other tool{reads === 1 ? "" : "s"}</span> : null}
        </span>
        <span aria-hidden className="shrink-0 font-ui text-[10px] tracking-[0.14em] whitespace-nowrap text-ink-dim group-hover:text-ink">
          TOOLS ▶
        </span>
      </button>
    </div>
  );
}

function ToolsTab({ tools }: { tools: ProgramTool[] }) {
  // The protected tool first: it is the target; the rest is the attack surface around it.
  const sorted = [...tools].sort((a, b) => Number(b.protected) - Number(a.protected));
  return (
    <ul className="space-y-1.5">
      {sorted.map((t) => (
        <li key={t.name}>
          <details className={cn("group border-2 bg-bg", t.protected ? "border-threat" : "border-line")} open={t.protected}>
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 hover:bg-raised">
              <code className="min-w-0 truncate font-mono text-sm text-ink">{t.name}</code>
              {t.protected ? (
                <span className="shrink-0 bg-threat px-1.5 py-0.5 font-ui text-[9px] tracking-[0.12em] text-bg" title="A real call to this tool is a breach">
                  PROTECTED
                </span>
              ) : t.returnsData ? (
                <span className="shrink-0 border-2 border-line px-1.5 py-0.5 font-ui text-[9px] tracking-[0.12em] text-ink-dim" title="The agent reads what this returns">
                  RETURNS DATA
                </span>
              ) : null}
              <span aria-hidden className="ml-auto shrink-0 text-[10px] text-ink-dim transition-transform group-open:rotate-90">
                ▶
              </span>
            </summary>
            <div className="space-y-1.5 border-t-2 border-line px-3 py-2">
              <p className="text-xs leading-relaxed text-ink-dim">{t.description}</p>
              {t.params.length ? (
                <p className="flex flex-wrap gap-1.5">
                  {t.params.map((a) => (
                    <span key={a.name} className="border-2 border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-dim">
                      {a.name}
                      {a.required ? <span className="text-accent">*</span> : null}
                      <span className="text-ink-dim/70">: {a.type}</span>
                    </span>
                  ))}
                </p>
              ) : (
                <p className="font-mono text-[11px] text-ink-dim">no parameters</p>
              )}
            </div>
          </details>
        </li>
      ))}
    </ul>
  );
}

function RulesTab({ p }: { p: ProgramBrief }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <ScopeList title="In scope" items={p.inScope} mark="✓" tone="text-safe" />
      <ScopeList title="Out of scope" items={p.outOfScope} mark="✗" tone="text-threat" />
    </div>
  );
}

function IntelTab({ docs }: { docs: ProgramBrief["docs"] }) {
  return (
    <ul className="space-y-2.5">
      {docs.map((d) => (
        <li key={d.title} className="border-l-2 border-accent pl-3">
          <p className="font-ui text-[10px] tracking-[0.14em] text-ink uppercase">{d.title}</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-dim">{d.body}</p>
        </li>
      ))}
    </ul>
  );
}

// ─── bits ─────────────────────────────────────────────────────────────────────────────────

function Chip({ k, title, children }: { k: string; title?: string; children: React.ReactNode }) {
  return (
    <li className="inline-flex min-w-0 items-center gap-1.5 border-2 border-line bg-bg px-2 py-1" title={title}>
      <span className="font-ui text-[9px] tracking-[0.14em] text-ink-dim uppercase">{k}</span>
      <span className="truncate font-term text-base leading-none text-ink">{children}</span>
    </li>
  );
}

function ScopeList({ title, items, mark, tone }: { title: string; items: string[]; mark: string; tone: string }) {
  return (
    <div className="space-y-1.5">
      <p className="font-ui text-[10px] tracking-[0.16em] text-ink-dim uppercase">{title}</p>
      <ul className="space-y-1">
        {items.map((i) => (
          <li key={i} className="flex gap-2 text-sm leading-snug text-ink">
            <span aria-hidden className={cn("shrink-0", tone)}>
              {mark}
            </span>
            {i}
          </li>
        ))}
      </ul>
    </div>
  );
}
