"use client";

import { AlertTriangle, Database } from "lucide-react";
import type { ArkivReadMeta } from "@/lib/api/client";
import { RABDI } from "@/lib/arkiv/config";
import { cn } from "@/lib/utils";

/**
 * Where the castles on screen came from. Live: the Arkiv block the query was answered at and the
 * query itself. Fallback: a visible warning, never a quiet one.
 *
 * @example <ArkivBar meta={data.arkiv} />
 */
export function ArkivBar({ meta, className }: { meta: ArkivReadMeta | undefined; className?: string }) {
  if (!meta) return null;
  if (meta.source === "arkiv") {
    return (
      <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone", className)}>
        <span className="inline-flex items-center gap-1.5 text-parchment/80">
          <Database className="size-3.5 text-ward" aria-hidden />
          Read from Arkiv
          {meta.block ? (
            <>
              {" "}
              at block{" "}
              <a href={`${RABDI.explorerUrl}/block/${meta.block}`} target="_blank" rel="noreferrer" className="tabular font-mono text-gold underline-offset-4 hover:underline">
                {meta.block}
              </a>
            </>
          ) : null}
        </span>
        <code className="min-w-0 truncate rounded bg-white/5 px-1.5 py-0.5 font-mono text-[11px] text-parchment/75" title={meta.query}>
          {meta.query}
        </code>
      </div>
    );
  }
  if (meta.error) {
    return (
      <div role="status" className={cn("flex items-start gap-2 rounded-xl border border-ember/40 bg-ember/10 px-3 py-2 text-xs text-parchment", className)}>
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-ember" aria-hidden />
        <span>
          <strong className="font-semibold">Arkiv unreachable.</strong> Showing the server&apos;s cached copy. <span className="text-stone">{meta.error}</span>
        </span>
      </div>
    );
  }
  return (
    <div className={cn("text-xs text-stone", className)}>
      <Database className="mr-1 inline size-3.5" aria-hidden />
      Stub mode: castles read from the server&apos;s database. Set <code className="font-mono">ARKIV_MODE=live</code> to read them from Arkiv.
    </div>
  );
}
