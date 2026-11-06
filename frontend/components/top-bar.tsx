"use client";

import { Suspense, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, LayoutGrid, Radio, Settings2, Trophy, Upload, type LucideIcon } from "lucide-react";
import { api } from "@/lib/api/client";
import { useConfig } from "@/lib/hooks/useConfig";
import { usePolling } from "@/lib/hooks/usePolling";
import { cn } from "@/lib/utils";
import { LED as LED_TEXT, NAV, VOCAB } from "@/lib/vocab";
import { Digits } from "@/components/pixel/digits";
import { LED } from "@/components/pixel/led";
import { PanelTitle, panelVariants } from "@/components/pixel/panel";
import { CalmToggle, CrtToggle, MuteToggle, SkinToggle } from "@/components/pixel/toggles";
import { playCue } from "@/components/pixel/sfx-link";

type NavItem = { href: string; label: string; icon: LucideIcon; match: (p: string) => boolean; pager?: boolean };

const LINKS: NavItem[] = [
  { href: "/", label: NAV.grid, icon: LayoutGrid, match: (p) => p === "/" || p.startsWith("/castle") || p.startsWith("/siege") },
  { href: "/hall", label: NAV.hall, icon: Trophy, match: (p) => p.startsWith("/hall") || p.startsWith("/replay") },
  { href: "/raider", label: NAV.agents, icon: Bot, match: (p) => p === "/raider" },
  { href: "/raider/approvals", label: NAV.pager, icon: Radio, match: (p) => p.startsWith("/raider/approvals"), pager: true },
  { href: "/publish", label: NAV.publish, icon: Upload, match: (p) => p.startsWith("/publish") },
];

/**
 * The HUD: wordmark, GRID · HALL · AGENTS · PAGER, season counters, chain-mode LED, sound and a
 * settings popover (skin, scanlines, calm). Hidden on /wall. Stub mode adds a hazard stripe.
 */
export function TopBar() {
  return (
    <Suspense fallback={<Hud pathname={null} />}>
      <RoutedHud />
    </Suspense>
  );
}

function RoutedHud() {
  const pathname = usePathname();
  if (pathname?.startsWith("/wall")) return null;
  return <Hud pathname={pathname} />;
}

function Hud({ pathname }: { pathname: string | null }) {
  const { config, error } = useConfig();
  const mode = config?.chain.mode;
  return (
    <header className="sticky top-0 z-40 border-b-2 border-line bg-bg/95 shadow-[0_2px_0_0_rgb(0_0_0/0.5)]">
      <div className="mx-auto flex h-12 max-w-7xl items-center gap-1.5 px-2 sm:gap-4 sm:px-6">
        <Wordmark />
        <Nav pathname={pathname} />
        <SeasonCounters />
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <ModePill mode={mode} offline={!config && Boolean(error)} />
          <MuteToggle compact />
          <SettingsPopover />
        </div>
      </div>
      {mode === "stub" ? (
        <div className="hazard border-t-2 border-dashed border-money/40 px-4 py-0.5 text-center font-ui text-[10px] tracking-[0.18em] text-money uppercase">
          {LED_TEXT.stubStripe}
          <span className="hidden text-money/70 sm:inline">
            {" "}· set <span className="font-mono normal-case tracking-normal">CHAIN_MODE=testnet</span> for real HBAR
          </span>
        </div>
      ) : null}
    </header>
  );
}

function Wordmark() {
  return (
    <Link href="/" className="group flex shrink-0 items-center gap-2 px-1 text-accent" aria-label={`${VOCAB.wordmark} — ${VOCAB.grid}`}>
      <svg viewBox="0 0 10 10" className="size-5 drop-shadow-[0_0_4px_currentColor]" shapeRendering="crispEdges" aria-hidden>
        <path d="M0 0h2v2h2V0h2v2h2V0h2v10H6V6H4v4H0z" fill="currentColor" />
      </svg>
      <span className="hidden font-pixel text-[14px] leading-none tracking-wider glow sm:inline">{VOCAB.wordmark}</span>
    </Link>
  );
}

// ─── nav ──────────────────────────────────────────────────────────────────────────────────

function Nav({ pathname }: { pathname: string | null }) {
  const waiting = usePendingApprovals();
  return (
    <nav className="flex min-w-0 items-center" aria-label="Main">
      {LINKS.map((l) => {
        const active = pathname ? l.match(pathname) : false;
        const Icon = l.icon;
        const count = l.pager ? waiting : 0;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            aria-label={count ? `${l.label} (${count} waiting)` : l.label}
            onClick={() => playCue("ui_blip")}
            className={cn(
              "relative flex h-12 items-center gap-1.5 px-2.5 font-ui text-[12px] tracking-[0.12em] whitespace-nowrap uppercase transition-colors sm:px-3",
              active
                ? "bg-raised text-ink after:absolute after:inset-x-0 after:bottom-[-2px] after:h-[2px] after:bg-accent after:shadow-[0_0_6px_var(--color-accent)]"
                : "text-ink-dim hover:bg-raised/50 hover:text-ink",
            )}
          >
            <Icon className={cn("size-4 shrink-0", active && "text-accent")} aria-hidden />
            <span className="hidden md:inline">{l.label}</span>
            {count > 0 ? (
              <span
                aria-hidden
                className="absolute top-1.5 right-0.5 grid h-4 min-w-4 animate-blink place-items-center bg-threat px-0.5 font-ui text-[10px] leading-none text-bg sm:right-1"
              >
                {count > 9 ? "9+" : count}
              </span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}

// The owner flag the pager page sets after a successful key entry (owner-approvals.tsx).
const OWNER_FLAG = "siege.ownerAuthed";
const OWNER_EVT = "siege:owner-auth";

function subscribeOwner(cb: () => void) {
  window.addEventListener(OWNER_EVT, cb);
  window.addEventListener("storage", cb);
  return () => {
    window.removeEventListener(OWNER_EVT, cb);
    window.removeEventListener("storage", cb);
  };
}
function readOwner(): boolean {
  try {
    return localStorage.getItem(OWNER_FLAG) === "1";
  } catch {
    return false;
  }
}

/** Pending approvals, polled only on the owner's device. */
function usePendingApprovals(): number {
  const owner = useSyncExternalStore(subscribeOwner, readOwner, () => false);
  const { data } = usePolling(() => api.approvals("pending"), 5000, { enabled: owner, key: owner ? "owner" : "" });
  return owner ? (data?.approvals.length ?? 0) : 0;
}

// ─── season counters (api.stats lands with the Hall package; hidden until then) ──────────

type SeasonLike = { season?: { ops?: number; breaches?: number; vaults?: number } };
const statsFn = (api as unknown as { stats?: () => Promise<SeasonLike> }).stats;

function SeasonCounters() {
  const { data } = usePolling(() => (statsFn ? statsFn() : Promise.resolve({} as SeasonLike)), 15_000, { enabled: Boolean(statsFn) });
  const s = data?.season;
  if (!s) return null;
  const items: [string, number | undefined, number][] = [
    ["OPS", s.ops, 4],
    ["BREACHES", s.breaches, 2],
    ["VAULTS", s.vaults, 2],
  ];
  return (
    <dl className="ml-2 hidden items-center gap-4 xl:flex" aria-label="Season">
      {items.map(([k, v, pad]) =>
        typeof v === "number" ? (
          <div key={k} className="flex items-baseline gap-1.5">
            <dt className="font-ui text-[10px] tracking-[0.14em] text-ink-dim">{k}</dt>
            <dd>
              <Digits value={v} pad={pad} size="sm" tone={k === "BREACHES" ? "money" : "ink"} />
            </dd>
          </div>
        ) : null,
      )}
    </dl>
  );
}

// ─── settings popover ─────────────────────────────────────────────────────────────────────

function SettingsPopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Display and sound settings"
        title="Settings"
        onClick={() => {
          playCue("ui_blip");
          setOpen((o) => !o);
        }}
        className={cn(
          "grid size-9 place-items-center text-ink-dim transition-colors hover:bg-raised hover:text-ink",
          open && "bg-raised text-ink",
        )}
      >
        <Settings2 className="size-4" aria-hidden />
      </button>
      {open ? (
        <div role="dialog" aria-label="Settings" className={cn(panelVariants({ tone: "raised" }), "absolute top-full right-0 z-50 mt-2 w-64")}>
          <PanelTitle title="Settings" />
          <div className="flex flex-col gap-3 p-3">
            <SkinToggle />
            <CrtToggle />
            <CalmToggle />
            <MuteToggle compact={false} />
            <p className="font-term text-lg leading-none text-ink-dim">Press M to mute.</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// ─── mode LED ─────────────────────────────────────────────────────────────────────────────

/** STUB vs TESTNET light (API OFFLINE when the config call fails). @example <ModePill mode="testnet" /> */
export function ModePill({ mode, offline }: { mode?: "stub" | "testnet"; offline?: boolean }) {
  if (offline) return <LED kind="offline" boxed />;
  if (!mode) return <span className="inline-block h-6 w-16 bg-line/40" aria-hidden />;
  if (mode === "stub")
    return <LED kind="stub" boxed title="Stub mode: no real HBAR moves. Set CHAIN_MODE=testnet for Hedera testnet." />;
  return <LED kind="testnet" boxed title="Live on Hedera testnet" />;
}
