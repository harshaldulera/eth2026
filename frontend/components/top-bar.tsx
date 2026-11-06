"use client";

import { Suspense } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Castle } from "lucide-react";
import { useConfig } from "@/lib/hooks/useConfig";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Arena", match: (p: string) => p === "/" || p.startsWith("/castle") || p.startsWith("/siege") },
  { href: "/raider", label: "Raider agents", short: "Agents", match: (p: string) => p === "/raider" },
  { href: "/raider/approvals", label: "Approvals", match: (p: string) => p.startsWith("/raider/approvals") },
];

/** Slim app bar: wordmark, nav, and the chain-mode pill (stub mode is loud on purpose). */
export function TopBar() {
  const { config, error } = useConfig();
  const mode = config?.chain.mode;
  return (
    <header className="sticky top-0 z-40 border-b border-arena-line/80 bg-arena-bg/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:gap-6 sm:px-6">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight text-parchment">
          <Castle className="size-5 text-gold" aria-hidden />
          <span className="text-lg">Siege</span>
        </Link>
        <Suspense fallback={<Nav pathname="" />}>
          <ActiveNav />
        </Suspense>
        <div className="ml-auto">
          <ModePill mode={mode} offline={!config && Boolean(error)} />
        </div>
      </div>
      {mode === "stub" ? (
        <div className="border-t border-dashed border-gold/30 bg-[repeating-linear-gradient(135deg,rgb(245_196_81/0.07)_0_10px,transparent_10px_20px)] px-4 py-1 text-center text-[11px] text-gold/90">
          Stub mode — payments and transactions are simulated. Set <span className="font-mono">CHAIN_MODE=testnet</span> for real HBAR on Hedera.
        </div>
      ) : null}
    </header>
  );
}

function ActiveNav() {
  return <Nav pathname={usePathname()} />;
}

function Nav({ pathname }: { pathname: string }) {
  return (
    <nav className="flex min-w-0 items-center gap-0.5 text-sm" aria-label="Main">
      {LINKS.map((l) => {
        const active = pathname ? l.match(pathname) : false;
        return (
          <Link
            key={l.href}
            href={l.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "rounded-lg px-2 py-1.5 whitespace-nowrap transition-colors sm:px-3",
              active ? "bg-white/[0.06] text-parchment" : "text-stone hover:text-parchment",
            )}
          >
            {l.short ? (
              <>
                <span className="sm:hidden">{l.short}</span>
                <span className="hidden sm:inline">{l.label}</span>
              </>
            ) : (
              l.label
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/** STUB vs TESTNET pill. @example <ModePill mode="testnet" /> */
export function ModePill({ mode, offline }: { mode?: "stub" | "testnet"; offline?: boolean }) {
  if (offline)
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-ember/40 px-2.5 py-1 text-[11px] font-semibold tracking-wider text-ember uppercase">
        <span className="size-1.5 rounded-full bg-ember" /> API offline
      </span>
    );
  if (!mode) return <span className="inline-block h-6 w-20 rounded-full bg-arena-line/50" aria-hidden />;
  if (mode === "stub")
    return (
      <span
        title="Stub mode: no real HBAR moves. Set CHAIN_MODE=testnet for Hedera testnet."
        className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-gold/60 bg-gold/10 px-2.5 py-1 text-[11px] font-bold tracking-wider text-gold uppercase"
      >
        <span className="size-1.5 rounded-full bg-gold" /> Stub
      </span>
    );
  return (
    <span
      title="Live on Hedera testnet"
      className="inline-flex items-center gap-1.5 rounded-full border border-ward/40 bg-ward/10 px-2.5 py-1 text-[11px] font-bold tracking-wider text-ward uppercase"
    >
      <span className="relative flex size-1.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-ward opacity-70" />
        <span className="relative inline-flex size-1.5 rounded-full bg-ward" />
      </span>
      Testnet
    </span>
  );
}
