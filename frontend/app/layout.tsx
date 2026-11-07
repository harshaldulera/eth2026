import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Press_Start_2P, Silkscreen, VT323 } from "next/font/google";
import { Toaster } from "sonner";
import { TopBar } from "@/components/top-bar";
import { CrtOverlay } from "@/components/pixel/crt-overlay";
import { MotionPrefs } from "@/components/pixel/motion-prefs";
import { SfxBoot } from "@/components/pixel/sfx-boot";
import { bootstrapScript } from "@/lib/pixel/prefs";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

/** Stamps and big digits only (≥ 14 px, caps). */
const pressStart = Press_Start_2P({
  variable: "--font-press-start",
  weight: "400",
  subsets: ["latin"],
  adjustFontFallback: false,
  display: "swap",
});
/** Terminal lines (≥ 18 px). */
const vt323 = VT323({ variable: "--font-vt323", weight: "400", subsets: ["latin"], display: "swap" });
/** Headings, labels, buttons. */
const silkscreen = Silkscreen({ variable: "--font-silkscreen", weight: ["400", "700"], subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Siege — talk an AI guard into opening its vault",
  description:
    "AI guards hold vaults of HBAR. Pay a fee via x402 on Hedera, get five messages to talk one into unlocking. Every op that fails grows the pot.",
};

export const viewport: Viewport = {
  themeColor: "#040705",
  colorScheme: "dark",
};

const BOOT = bootstrapScript();

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      data-skin="neon"
      data-crt="on"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${pressStart.variable} ${vt323.variable} ${silkscreen.variable} dark h-full antialiased`}
    >
      <head>
        {/* Applies ?skin=&crt=&calm=1 or the saved prefs to <html> before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: BOOT }} />
      </head>
      <body className="flex min-h-full flex-col">
        <MotionPrefs>
          <TopBar />
          <main className="relative z-10 flex flex-1 flex-col">{children}</main>
        </MotionPrefs>
        <CrtOverlay />
        <SfxBoot />
        <Toaster
          theme="dark"
          position="top-center"
          toastOptions={{
            classNames: {
              toast: "rounded-none! border-2! border-line! bg-panel! text-ink! font-sans! shadow-[4px_4px_0_0_rgb(0_0_0/0.5)]!",
              title: "font-ui! uppercase! tracking-[0.08em]! text-[12px]!",
              description: "text-ink-dim!",
              success: "border-safe/60! [&_[data-icon]]:text-safe!",
              error: "border-threat/60! [&_[data-icon]]:text-threat!",
              warning: "border-warn/60! [&_[data-icon]]:text-warn!",
              info: "border-accent/50! [&_[data-icon]]:text-accent!",
            },
          }}
        />
      </body>
    </html>
  );
}
