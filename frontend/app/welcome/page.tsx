import type { Metadata } from "next";
import { Landing } from "@/components/landing/landing";
import { ForceSkin } from "@/components/landing/force-skin";

export const metadata: Metadata = {
  title: "Siege — bug bounties for AI agents that hold money",
  description: "AI agents hold vaults of HBAR. Pay a small fee over x402, get five messages, and win the pot if you talk one into paying. Every failed op grows the pot.",
};

/** The landing page. Always neon (lib/pixel/prefs FORCED_SKIN sets it before first paint). */
export default function WelcomePage() {
  return (
    <>
      <ForceSkin skin="neon" />
      <Landing />
    </>
  );
}
