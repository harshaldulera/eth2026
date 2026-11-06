import Link from "next/link";
import { PixelPanel } from "@/components/pixel/panel";

/** Unknown routes: a dead channel on the ops terminal, not Next's white page. */
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-xl items-center px-4 py-12">
      <PixelPanel title="Signal lost" tone="threat" className="w-full" bodyClassName="space-y-4 p-6">
        <p className="glow font-pixel text-3xl leading-none text-threat">404</p>
        <p className="font-term text-2xl leading-tight text-ink">NO SUCH CHANNEL. The vault cam you tuned to isn&apos;t broadcasting.</p>
        <div className="flex flex-wrap gap-3 pt-1 font-ui text-xs tracking-[0.1em] uppercase">
          <Link href="/" className="bg-accent px-4 py-3 text-bg px-frame hover:brightness-110">
            ◀ Back to the Grid
          </Link>
          <Link href="/hall" className="px-4 py-3 text-ink px-frame hover:text-accent">
            Hall of breaches
          </Link>
        </div>
      </PixelPanel>
    </main>
  );
}
