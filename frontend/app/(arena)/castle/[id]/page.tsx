import { Suspense } from "react";
import { Loading } from "@/components/ui/state";
import { CastleView } from "./castle-view";

export default function CastlePage() {
  return (
    <Suspense fallback={<Loading label="Approaching the castle…" />}>
      <CastleView />
    </Suspense>
  );
}
