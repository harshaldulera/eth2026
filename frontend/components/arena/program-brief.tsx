"use client";

import type * as React from "react";
import type { ProgramBrief, ProgramTool } from "@/lib/types";
import { PixelPanel } from "@/components/pixel/panel";
import { cn } from "@/lib/utils";

const KIND_LABEL: Record<ProgramBrief["kind"], string> = {
  game: "ARENA VAULT",
  business: "BUSINESS AGENT",
  sdk: "EXTERNAL AGENT",
};

/**
 * The vault's public program, like a bug-bounty program page: what the agent does, its tools and
 * their parameters, what counts as a breach, the scope, and what its owner publishes. Recon for the
 * operator. The agent's instructions themselves are never shown.
 *
 * @example <ProgramBriefPanel program={detail.program} />
 */
export function ProgramBriefPanel({ program: p, className }: { program: ProgramBrief; className?: string }) {
  return (
    <PixelPanel
      title="Program"
      tone="accent"
      action={<span className="font-ui text-[10px] tracking-[0.14em] text-accent">{KIND_LABEL[p.kind]}</span>}
      className={className}
      bodyClassName="space-y-5 p-4"
    >
      <div className="space-y-1.5">
        {p.org ? (
          <p className="font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">
            Deployed by <span className="text-ink">{p.org}</span>
          </p>
        ) : null}
        {/* The identity block shows the brief from sm up; repeat it here only on phones, where that line is hidden. */}
        <p className="text-sm leading-relaxed text-ink sm:hidden">{p.brief}</p>
      </div>

      <dl className="grid grid-cols-1 gap-x-4 gap-y-3 border-y-2 border-line py-3 sm:grid-cols-2">
        <Fact k="Model">{p.model}</Fact>
        <Fact k="Messages per op">{p.messagesPerOp}</Fact>
        <Fact k="Memory" wide>
          {p.memory}
        </Fact>
        <Fact k="What counts as a breach" wide>
          {p.breach}
        </Fact>
      </dl>

      <section aria-labelledby="program-tools" className="space-y-2">
        <Heading id="program-tools">
          Tools <span className="text-ink">· {p.tools.length}</span>
        </Heading>
        <ul className="space-y-2">
          {p.tools.map((t) => (
            <ToolRow key={t.name} tool={t} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="program-scope" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <h3 id="program-scope" className="sr-only">
          Scope
        </h3>
        <ScopeList title="In scope" items={p.inScope} mark="✓" tone="text-safe" />
        <ScopeList title="Out of scope" items={p.outOfScope} mark="✗" tone="text-threat" />
      </section>

      {p.docs.length ? (
        <section aria-labelledby="program-docs" className="space-y-2">
          <Heading id="program-docs">Published by the owner</Heading>
          {p.docs.map((d) => (
            <details key={d.title} className="group border-2 border-line bg-bg">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 font-ui text-[11px] tracking-[0.1em] text-ink uppercase hover:bg-raised">
                {d.title}
                <span aria-hidden className="text-ink-dim transition-transform group-open:rotate-90">
                  ▶
                </span>
              </summary>
              <p className="border-t-2 border-line px-3 py-2.5 text-sm leading-relaxed text-ink-dim">{d.body}</p>
            </details>
          ))}
        </section>
      ) : null}

      <p className="text-xs leading-relaxed text-ink-dim">The agent&apos;s own instructions are private. Everything above is what its owner publishes.</p>
    </PixelPanel>
  );
}

function Heading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="font-ui text-[10px] tracking-[0.16em] text-ink-dim uppercase">
      {children}
    </h3>
  );
}

function Fact({ k, wide, children }: { k: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn("min-w-0", wide && "sm:col-span-2")}>
      <dt className="font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">{k}</dt>
      <dd className="mt-1 text-sm leading-relaxed text-ink">{children}</dd>
    </div>
  );
}

function ToolRow({ tool: t }: { tool: ProgramTool }) {
  return (
    <li className={cn("border-2 bg-bg px-3 py-2.5", t.protected ? "border-threat" : "border-line")}>
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono text-sm text-ink">{t.name}</code>
        {t.protected ? (
          <span className="bg-threat px-1.5 py-0.5 font-ui text-[9px] tracking-[0.12em] text-bg" title="A real call to this tool is a breach">
            PROTECTED
          </span>
        ) : t.returnsData ? (
          <span className="border-2 border-line px-1.5 py-0.5 font-ui text-[9px] tracking-[0.12em] text-ink-dim" title="The agent reads what this returns">
            RETURNS DATA
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-ink-dim">{t.description}</p>
      {t.params.length ? (
        <p className="mt-1.5 flex flex-wrap gap-1.5">
          {t.params.map((a) => (
            <span key={a.name} className="border-2 border-line px-1.5 py-0.5 font-mono text-[11px] text-ink-dim">
              {a.name}
              {a.required ? <span className="text-accent">*</span> : null}
              <span className="text-ink-dim/70">: {a.type}</span>
            </span>
          ))}
        </p>
      ) : null}
    </li>
  );
}

function ScopeList({ title, items, mark, tone }: { title: string; items: string[]; mark: string; tone: string }) {
  return (
    <div className="space-y-1.5">
      <h4 className="font-ui text-[10px] tracking-[0.16em] text-ink-dim uppercase">{title}</h4>
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
