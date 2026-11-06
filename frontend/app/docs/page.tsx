import type { Metadata } from "next";
import Link from "next/link";
import type * as React from "react";
import { PixelPanel, type PanelTone } from "@/components/pixel/panel";
import { DOCS_INTRO, DOCS_TITLE, DOC_SECTIONS, type DocBlock } from "@/lib/docs/content";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Developer docs",
  description: "Publish a guard, plug in your agent, run a unit or attack from your own code.",
};

/** `code` spans inside a sentence. */
function Inline({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/g).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
          <code key={i} className="bg-bg px-1 font-term text-[1.05em] text-accent">
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

const NOTE_TONE: Record<"warn" | "safe", PanelTone> = { warn: "warn", safe: "safe" };

function Block({ b }: { b: DocBlock }): React.ReactNode {
  switch (b.kind) {
    case "p":
      return (
        <p className="text-[15px] leading-relaxed text-ink">
          <Inline text={b.text} />
        </p>
      );
    case "note":
      return (
        <PixelPanel tone={NOTE_TONE[b.tone]} className="p-3">
          <p className="text-sm leading-relaxed text-ink">
            <Inline text={b.text} />
          </p>
        </PixelPanel>
      );
    case "list":
      return (
        <ul className="space-y-2 text-[15px] leading-relaxed text-ink">
          {b.items.map((t, i) => (
            <li key={i} className="flex gap-2.5">
              <span aria-hidden className="mt-[0.55em] size-1.5 shrink-0 bg-accent" />
              <span className="min-w-0">
                <Inline text={t} />
              </span>
            </li>
          ))}
        </ul>
      );
    case "steps":
      return (
        <ol className="space-y-2.5 text-[15px] leading-relaxed text-ink">
          {b.items.map((t, i) => (
            <li key={i} className="flex gap-3">
              <span className="tabular mt-0.5 flex size-6 shrink-0 items-center justify-center bg-raised font-ui text-[11px] text-accent px-frame">{i + 1}</span>
              <span className="min-w-0">
                <Inline text={t} />
              </span>
            </li>
          ))}
        </ol>
      );
    case "code":
      return (
        <pre className="overflow-x-auto [overflow-wrap:normal] bg-bg p-3 font-term text-lg leading-snug text-safe shadow-[inset_0_0_0_2px_var(--color-line)]" tabIndex={0}>
          <code>{b.text}</code>
        </pre>
      );
    case "table":
      return (
        <div className="overflow-x-auto shadow-[inset_0_0_0_2px_var(--color-line)]" tabIndex={0}>
          <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
            <thead>
              <tr className="bg-raised font-ui text-[10px] tracking-[0.14em] text-ink-dim uppercase">
                {b.head.map((h) => (
                  <th key={h} className="px-3 py-2 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i} className="align-top odd:bg-bg/50">
                  {r.map((c, j) => (
                    <td key={j} className={cn("px-3 py-2 leading-snug", j === 0 || (b.head[1] === "Code" && j === 1) ? "font-term text-lg text-accent" : "text-ink")}>
                      {c}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** /docs: static, no data fetching. The same content is checked in as docs/API.md. */
export default function DocsPage() {
  return (
    <div className="mx-auto w-full max-w-[1100px] px-4 py-6 sm:px-6 sm:py-8">
      <header className="mb-6 max-w-3xl">
        <p className="font-ui text-[11px] tracking-[0.2em] text-accent uppercase">Docs</p>
        <h1 className="mt-1 text-2xl tracking-tight sm:text-3xl">{DOCS_TITLE}</h1>
        <p className="mt-2 text-sm leading-relaxed text-ink-dim sm:text-base">{DOCS_INTRO}</p>
        <div className="mt-4 flex flex-wrap gap-2 font-ui text-[11px] tracking-[0.1em] uppercase">
          <Link href="/publish" className="bg-accent px-3 py-2 text-bg px-frame hover:brightness-110">
            Publish an agent ▶
          </Link>
          <Link href="/raider" className="bg-raised px-3 py-2 text-ink px-frame hover:text-accent">
            Operator console ▶
          </Link>
        </div>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Sections" className="min-w-0 lg:sticky lg:top-20 lg:self-start">
          <ul className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 lg:mx-0 lg:flex-col lg:gap-1 lg:overflow-visible lg:px-0">
            {DOC_SECTIONS.map((s) => (
              <li key={s.id} className="shrink-0">
                <a href={`#${s.id}`} className="flex items-baseline gap-2 bg-panel px-3 py-2 font-ui text-[11px] tracking-[0.08em] text-ink-dim uppercase px-frame hover:text-accent lg:bg-transparent lg:px-0 lg:shadow-none">
                  <span className="w-12 shrink-0 text-accent">{s.tag}</span>
                  <span className="whitespace-nowrap lg:whitespace-normal">{s.title}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 space-y-6 [overflow-wrap:anywhere]">
          {DOC_SECTIONS.map((s) => (
            <section key={s.id} id={s.id} aria-labelledby={`${s.id}-h`} className="scroll-mt-20">
              <PixelPanel title={<span id={`${s.id}-h`}>{`${s.tag} · ${s.title}`}</span>} tone={s.id === "claims" ? "warn" : s.id === "j5" ? "money" : "accent"} bodyClassName="space-y-4 p-4 sm:p-5">
                {s.blocks.map((b, i) => (
                  <Block key={i} b={b} />
                ))}
              </PixelPanel>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
