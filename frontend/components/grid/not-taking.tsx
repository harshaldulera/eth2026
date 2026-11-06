"use client";

import Link from "next/link";
import type { Castle } from "@/lib/types";
import { vaultStateOf } from "@/lib/money/vault";
import { timeAgo } from "@/lib/money/format";
import { LED as LED_TEXT, EMPTY } from "@/lib/vocab";
import { LED } from "@/components/pixel/led";
import { PixelPanel } from "@/components/pixel/panel";
import { vaultStateLed } from "@/components/arena/vault-state";
import { GuardPost } from "./guard-post";
import { vaultPath } from "@/lib/vault-path";

/**
 * Vaults that are not taking ops (offline, setting up, breached, closed), one terminal row each
 * with the reason light. `noneGuarding` heads it with NO VAULT IS TAKING OPS.
 *
 * @example <NotTakingOps castles={resting} now={now} />
 */
export function NotTakingOps({ castles, now, noneGuarding, className }: { castles: Castle[]; now: number; noneGuarding?: boolean; className?: string }) {
  if (castles.length === 0) return null;
  return (
    <PixelPanel
      title={noneGuarding ? EMPTY.noVaultTaking.title : "Not taking ops"}
      action={<span className="tabular font-term text-base text-ink-dim">{castles.length}</span>}
      className={className}
    >
      {noneGuarding ? <p className="px-4 pt-3 text-sm text-ink-dim">{EMPTY.noVaultTaking.body}</p> : null}
      <ul className="divide-y-2 divide-line/60">
        {castles.map((c) => {
          const state = vaultStateOf(c);
          const led = vaultStateLed(state, c.transport ?? "hosted");
          const label = state === "dormant" && c.lastSeenAt && now ? LED_TEXT.offline(timeAgo(c.lastSeenAt, now)) : led.label;
          return (
            <li key={c.id}>
              <Link href={`${vaultPath(c.id)}`} className="flex items-center gap-3 px-3 py-2 transition-colors hover:bg-raised focus-visible:bg-raised">
                <GuardPost castle={c} scale={1} className="hidden sm:block" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-ui text-xs tracking-[0.04em] text-ink uppercase">{c.name}</span>
                  <span className="block truncate text-xs text-ink-dim">{c.guardianName}</span>
                </span>
                <LED kind={led.kind} label={label} blink={led.blink} className="shrink-0" />
              </Link>
            </li>
          );
        })}
      </ul>
    </PixelPanel>
  );
}
