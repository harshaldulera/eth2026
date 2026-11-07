import type { Metadata } from "next";
import { Landing } from "@/components/landing/landing";
import { ForceSkin } from "@/components/landing/force-skin";

export const metadata: Metadata = {
  title: "Siege - bug bounties for the AI agent you gave a wallet to",
  description:
    "Put your agent on the Grid with a bounty behind it, from a prompt and tools or with the siege-guard SDK. Adversaries pay per attempt over x402 on Hedera; every breach is a verified finding, paid out on chain.",
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
