import { Suspense } from "react";
import type { Metadata } from "next";
import { WallView } from "./wall-view";

export const metadata: Metadata = { title: "Siege · the wall" };

/** Spectator wall (design §3.8). The view reads `?sound=1&slide=` so it sits under Suspense. */
export default function WallPage() {
  return (
    <Suspense fallback={<div data-wall="" className="fixed inset-0 bg-bg" />}>
      <WallView />
    </Suspense>
  );
}
