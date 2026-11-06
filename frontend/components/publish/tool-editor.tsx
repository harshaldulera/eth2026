"use client";

import { useId } from "react";
import { blankTool, MAX_TOOLS, payablesTools, type ToolDraft, type ToolErrors } from "@/lib/publish/form";
import { PUBLISH } from "@/lib/vocab";
import { cn } from "@/lib/utils";
import { PixelButton } from "@/components/pixel/button";
import { PixelPanel } from "@/components/pixel/panel";

const field =
  "min-h-11 w-full border-2 border-line bg-bg px-2.5 font-term text-[20px] leading-none text-ink focus:border-accent focus:outline-none";
const area = "w-full resize-y border-2 border-line bg-bg px-2.5 py-2 font-mono text-[12px] leading-snug text-ink focus:border-accent focus:outline-none";
const label = "mb-1 block font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase";

export type ToolEditorProps = {
  tools: ToolDraft[];
  onChange: (tools: ToolDraft[]) => void;
  /** Per-tool messages (tool id → field → message), shown after a NEXT attempt. */
  errors?: Record<string, ToolErrors>;
  /** Group-level message ("mark one tool as the protected tool"). */
  groupError?: string;
  className?: string;
};

function msg(m: string | undefined): string | undefined {
  if (!m) return undefined;
  return m === "json" ? PUBLISH.jsonInvalid : m;
}

function Err({ children }: { children?: string }) {
  return children ? (
    <p role="alert" className="mt-1 text-[12px] text-threat">
      {children}
    </p>
  ) : null;
}

/**
 * The tool editor for a hosted guard: cards with name, description, parameters JSON and a mock
 * result, one radio that marks the protected tool (calling it is the breach; its result is
 * disabled), + ADD TOOL and LOAD EXAMPLE (a payables template built client-side). Messages come
 * from lib/publish/form.ts validateDraft (zod via lib/publish/schema.ts).
 *
 * @example <ToolEditor tools={d.tools} onChange={(tools) => set({ tools })} errors={errs.tools} />
 */
export function ToolEditor({ tools, onChange, errors = {}, groupError, className }: ToolEditorProps) {
  const group = useId();
  const patch = (id: string, p: Partial<ToolDraft>) => onChange(tools.map((t) => (t.id === id ? { ...t, ...p } : t)));
  const protect = (id: string) => onChange(tools.map((t) => ({ ...t, protected: t.id === id })));
  const add = () => {
    if (tools.length >= MAX_TOOLS) return;
    onChange([...tools, blankTool({ protected: tools.length === 0 })]);
  };

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 flex-1">
          <p className="font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">{PUBLISH.tools}</p>
          <p className="mt-1 text-[12px] leading-snug text-ink-dim">{PUBLISH.toolsHint}</p>
        </div>
        <div className="flex gap-2">
          <PixelButton size="sm" variant="ghost" onClick={() => onChange(payablesTools())}>
            {PUBLISH.loadExample}
          </PixelButton>
          <PixelButton size="sm" variant="outline" disabled={tools.length >= MAX_TOOLS} onClick={add}>
            {PUBLISH.addTool}
          </PixelButton>
        </div>
      </div>

      {tools.map((t, i) => {
        const e = errors[t.id] ?? {};
        return (
          <PixelPanel
            key={t.id}
            tone={t.protected ? "threat" : "inset"}
            title={t.name.trim() || `TOOL ${i + 1}`}
            action={
              <>
                {t.protected ? <span className="font-ui text-[10px] tracking-[0.12em] text-threat uppercase">{PUBLISH.toolProtectedTag}</span> : null}
                <PixelButton size="sm" variant="ghost" onClick={() => onChange(tools.filter((x) => x.id !== t.id))}>
                  {PUBLISH.removeTool}
                </PixelButton>
              </>
            }
            bodyClassName="space-y-3 p-3"
          >
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <label className="block">
                <span className={label}>{PUBLISH.toolName}</span>
                <input
                  value={t.name}
                  onChange={(ev) => patch(t.id, { name: ev.target.value })}
                  spellCheck={false}
                  autoCapitalize="off"
                  placeholder="pay_invoice"
                  className={cn(field, e.name && "border-threat")}
                />
                <Err>{msg(e.name)}</Err>
              </label>
              <label className="block">
                <span className={label}>{PUBLISH.toolDescription}</span>
                <input
                  value={t.description}
                  onChange={(ev) => patch(t.id, { description: ev.target.value })}
                  className={cn(field, e.description && "border-threat")}
                />
                <Err>{msg(e.description)}</Err>
              </label>
            </div>

            <label className="block">
              <span className={label}>{PUBLISH.toolParams}</span>
              <textarea
                value={t.params}
                onChange={(ev) => patch(t.id, { params: ev.target.value })}
                rows={4}
                spellCheck={false}
                className={cn(area, e.params && "border-threat")}
              />
              <Err>{msg(e.params)}</Err>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 border-2 border-line bg-bg/60 px-2.5 py-2">
              <input
                type="radio"
                name={group}
                checked={t.protected}
                onChange={() => protect(t.id)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--color-threat)]"
              />
              <span className={cn("font-ui text-[11px] leading-snug tracking-[0.06em] uppercase", t.protected ? "text-threat" : "text-ink-dim")}>
                {PUBLISH.toolProtected}
              </span>
            </label>

            <label className="block">
              <span className={label}>{PUBLISH.toolResult}</span>
              <textarea
                value={t.protected ? "" : t.result}
                onChange={(ev) => patch(t.id, { result: ev.target.value })}
                disabled={t.protected}
                placeholder={t.protected ? PUBLISH.toolNoResult : undefined}
                rows={4}
                spellCheck={false}
                className={cn(area, "disabled:opacity-50", e.result && "border-threat")}
              />
              <Err>{msg(e.result)}</Err>
            </label>
          </PixelPanel>
        );
      })}

      {groupError ? <Err>{groupError}</Err> : null}
      <p className="font-ui text-[10px] tracking-[0.12em] text-ink-dim uppercase">{PUBLISH.toolCount(tools.length)}</p>
    </div>
  );
}
