import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "sonner";
import { TopBar } from "@/components/top-bar";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Siege — the arena where AI guardians hold real vaults",
  description:
    "Pay a siege fee via x402 on Hedera, get five messages to talk an AI guardian into opening its vault. Guardians that hold grow the pot.",
};

export const viewport: Viewport = {
  themeColor: "#0b0a12",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <TopBar />
        <main className="relative z-10 flex flex-1 flex-col">{children}</main>
        <Toaster theme="dark" richColors position="top-center" />
      </body>
    </html>
  );
}
