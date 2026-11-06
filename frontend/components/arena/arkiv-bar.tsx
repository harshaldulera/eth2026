"use client";

import type { ArkivReadMeta } from "@/lib/api/client";
import { RABDI } from "@/lib/arkiv/config";
import { LED } from "@/components/pixel/led";
import { cn } from "@/lib/utils";

/**
 * Where the vaults on screen came from, as one terminal line. Live: the Arkiv block the query was
 * answered at and the query itself. Fallback: a visible warning, never a quiet one.
 *
 * @example <ArkivBar meta={data.arkiv} />
 */
export function ArkivBar({ meta, className }: { meta: ArkivReadMeta | undefined; className?: string }) {
  if (!meta) return null;
  const line = "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-term text-lg leading-tight";
  if (meta.source === "arkiv") {
    return (
      <div className={cn(line, "text-ink-dim", className)}>
        <LED kind="safe" label="ARKIV" title="This list was read from Arkiv" />
        <span className="text-ink">
          read from Arkiv
          {meta.block ? (
            <>
              {" "}
              · block{" "}
              <a
                href={`${RABDI.explorerUrl}/block/${meta.block}`}
                target="_blank"
                rel="noreferrer"
                className="tabular text-money underline decoration-money/40 underline-offset-4 hover:decoration-money"
              >
                {meta.block}
              </a>
            </>
          ) : null}
        </span>
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-ink-dim" title={meta.query}>
          <span aria-hidden>&gt; </span>
          {meta.query}
        </code>
      </div>
    );
  }
  if (meta.error) {
    return (
      <div role="status" className={cn(line, "border-2 border-threat/50 bg-threat/10 px-3 py-1.5 text-ink", className)}>
        <LED kind="offline" label="ARKIV UNREACHABLE" />
        <span>
          Showing the server&apos;s cached copy. <span className="text-ink-dim">{meta.error}</span>
        </span>
      </div>
    );
  }
  return (
    <div className={cn(line, "text-ink-dim", className)}>
      <LED kind="stub" label="STUB" title="Stub mode: not read from Arkiv" />
      <span>
        vaults read from the server&apos;s database · set <code className="font-mono text-xs text-ink">ARKIV_MODE=live</code> to read them from Arkiv
      </span>
    </div>
  );
}
