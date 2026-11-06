import { Suspense } from "react";
import { Loading } from "@/components/ui/state";
import { SiegeRoom } from "./siege-room";

export default function SiegePage() {
  return (
    <Suspense fallback={<Loading label="Entering the siege room…" />}>
      <SiegeRoom />
    </Suspense>
  );
}
