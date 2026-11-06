import { Suspense } from "react";
import { Loading } from "@/components/ui/state";
import { ReplayView } from "./replay-view";

export default function ReplayPage() {
  return (
    <Suspense fallback={<Loading label="Rewinding the tape…" />}>
      <ReplayView />
    </Suspense>
  );
}
